import React, { useEffect, useState } from 'react';
import { callLtApi, type HydratedBundle } from '../lib/api';
import type { ProviderProtocol } from '../types/lt-public-v1';

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

export function ProvidersView({
  bundle,
  onRefreshBundle,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
}) {
  const gw = bundle.gateway;
  const presets = bundle.providerPresets ?? [];
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // External / Managed gateway config inputs (write-only webKey!)
  const [extGwUrl, setExtGwUrl] = useState(gw.gatewayUrl || 'http://127.0.0.1:3425');
  const [extWebUrl, setExtWebUrl] = useState(gw.webAdminUrl || 'http://127.0.0.1:3430');
  const [extWebKey, setExtWebKey] = useState('');
  const [extUrlsDirty, setExtUrlsDirty] = useState(false);

  // External OpenAI-compatible gateways (`save-external` / `remove-external`)
  const [extRelayId, setExtRelayId] = useState('');
  const [extRelayName, setExtRelayName] = useState('');
  const [extRelayEndpoint, setExtRelayEndpoint] = useState('');
  const [extRelayProtocol, setExtRelayProtocol] = useState<ProviderProtocol>('openai-chat');
  const [extRelayKey, setExtRelayKey] = useState('');
  const [extRelayKeyOptional, setExtRelayKeyOptional] = useState(false);

  useEffect(() => {
    if (extUrlsDirty) return;
    if (gw.gatewayUrl) setExtGwUrl(gw.gatewayUrl);
    if (gw.webAdminUrl) setExtWebUrl(gw.webAdminUrl);
  }, [gw.gatewayUrl, gw.webAdminUrl, extUrlsDirty]);

  // Add Provider form
  const [vendorPreset, setVendorPreset] = useState(
    presets[0]?.vendorId || (presets.length === 0 ? 'custom' : 'deepseek'),
  );
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customApi, setCustomApi] = useState<'chat' | 'responses' | 'anthropic' | 'gemini'>('chat');
  const [rawApiKey, setRawApiKey] = useState('');
  const [discoveredPreview, setDiscoveredPreview] = useState<Array<{ id: string; name: string }>>([]);

  // Multi-key drawer state
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [extraKeyName, setExtraKeyName] = useState('');
  const [extraKeySecret, setExtraKeySecret] = useState('');

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
          setMessage('Magpie OAuth 登录已完成并同步凭据');
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
  }, [oauthSession?.id, oauthSession?.state, onRefreshBundle]);

  async function runGatewayAction(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await callLtApi<any>('gateway/control', { action, ...extra });
      if (action === 'check-compatibility') {
        const ok = res.compatibility?.ok;
        setMessage(
          ok
            ? `Magpie 上游接口契约校验通过（检测版本 ${res.compatibility.detectedVersion || '未知'}）`
            : `兼容性检查提示：${JSON.stringify(res.compatibility?.checks || res.compatibility)}`,
        );
      } else if (action === 'rollback') {
        setMessage(`已回退至版本 ${res.rollback?.rolledBackTo}`);
      } else if (action === 'save-external') {
        setMessage('已保存外部兼容网关（明文密钥仅写入服务端隔离凭据库）');
      } else if (action === 'remove-external') {
        setMessage('已移除外部兼容网关');
      } else {
        setMessage(`网关操作「${action}」已完成（当前状态：${res.status?.state}）`);
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
      setMessage(`成功从上游探测到 ${list.length} 个模型`);
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
      setRawApiKey(''); // Never retain secret in input state after write
      setDiscoveredPreview([]);
      setMessage('已写入供应商与密钥（明文密钥已从前端清除，仅保留脱敏引用）');
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
        setMessage(
          first?.ok
            ? `连通性测试通过（HTTP ${first.status} · 延迟 ${latency ?? 0}ms）`
            : `连通性测试未通过（HTTP ${first?.status ?? 'ERR'}）`,
        );
      } else {
        setMessage(`操作「${operation}」已应用`);
      }
      setExtraKeySecret('');
      await onRefreshBundle();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStartOAuth() {
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
      }>('providers/mutate', { operation: 'oauth-start', agent: oauthAgent });
      const op = res.operationResult;
      setOauthSession({
        id: op.id,
        authUrl: op.url || op.authUrl,
        state: op.state || op.status || 'waiting',
        code: op.code,
        pasteCallback: op.pasteCallback,
      });
      setMessage(`已通过 Magpie 原生机制发起 ${oauthAgent} 登录引导`);
    } catch (e: any) {
      setError(`发起 OAuth 失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelOAuth() {
    if (!oauthSession) return;
    const signInId = oauthSession.id;
    setOauthSession(null);
    setOauthCallbackUrl('');
    setBusy(true);
    setError(null);
    try {
      await callLtApi('providers/mutate', { operation: 'oauth-cancel', signInId });
      setMessage('已取消当前 OAuth 登录流程');
    } catch (e: any) {
      setError(`取消 OAuth 失败：${e.message}`);
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
      setMessage('OAuth 回调已交由 Magpie 完成认证');
      await onRefreshBundle();
    } catch (e: any) {
      setError(`提交回调失败：${e.message}`);
    } finally {
      setBusy(false);
    }
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

  return (
    <div>
      <div className="lt-section-header">
        <div>
          <div className="lt-section-kicker">Magpie Ecosystem & Direct Vendors</div>
          <h1 className="lt-section-title">网关托管、供应商接入、多 Key 池与模型发现</h1>
          <p className="lt-section-desc">
            统一管理 LT 隔离托管的 Magpie 网关（MIT）、外部已有网关及直连 Solo-Key 渠道。所有密钥单向写入，界面与日志严禁回显明文凭据。
          </p>
        </div>
      </div>

      {error && <div className="lt-banner lt-banner-danger"><span>{error}</span><button className="lt-btn lt-btn-sm" onClick={() => setError(null)}>关闭</button></div>}
      {message && <div className="lt-banner"><span>{message}</span><button className="lt-btn lt-btn-sm" onClick={() => setMessage(null)}>关闭</button></div>}

      {/* 1. Magpie Lifecycle Card */}
      <div className="lt-card lt-card-authority" style={{ marginBottom: 18 }}>
        <div className="lt-card-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>Magpie 网关生命周期与上游兼容控制</span>
            <span className="lt-seal">{gw.version.license}</span>
            <span className="lt-tag">模式: {gw.mode.toUpperCase()}</span>
          </div>
          <span className="lt-status">
            <span className={`lt-dot ${gw.state === 'running' ? 'lt-dot-ready' : gw.state === 'error' ? 'lt-dot-error' : 'lt-dot-warn'}`} />
            <strong>{gw.state.toUpperCase()}</strong>
            {gw.health.latencyMs !== null ? ` · ${gw.health.latencyMs}ms` : ''}
            {gw.health.pid ? ` · PID ${gw.health.pid}` : ''}
          </span>
        </div>

        <div className="lt-num" style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: 'var(--lt-fg-secondary)', marginBottom: 12 }}>
          <span>推理入口: <code className="lt-mono">{gw.gatewayUrl || '已停用'}</code></span>
          <span>管理接口: <code className="lt-mono">{gw.webAdminUrl || '—'}</code> ({gw.managementAuthenticated ? '已鉴权' : '只读/未配置管理密钥'})</span>
          <span>当前版本: <strong>{gw.version.current || '未检测'}</strong>（固定基线 {gw.version.pinned} · 验证区间 {gw.version.testedRange}）</span>
          <span>异常自恢复次数: <strong>{gw.recoveryCount}</strong></span>
        </div>

        {gw.lastError && (
          <div className="lt-banner lt-banner-warn" style={{ marginBottom: 12 }}>
            <span>最近网关异常 ({gw.lastError.code})：{gw.lastError.message}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="lt-btn lt-btn-primary" disabled={busy} onClick={() => void runGatewayAction('start')}>
            启动 LT 托管实例
          </button>
          <button className="lt-btn" disabled={busy || gw.mode !== 'managed'} onClick={() => void runGatewayAction('restart')}>
            重启网关
          </button>
          <button className="lt-btn" disabled={busy || gw.mode !== 'managed'} onClick={() => void runGatewayAction('stop')}>
            停止网关
          </button>
          <button className="lt-btn" disabled={busy} onClick={() => void runGatewayAction('install')}>
            安装/导入本地二进制
          </button>
          <button className="lt-btn" disabled={busy} onClick={() => void runGatewayAction('check-compatibility')}>
            校验上游接口兼容性
          </button>
          {gw.version.rollbackAvailable && (
            <button className="lt-btn lt-btn-danger" disabled={busy} onClick={() => void runGatewayAction('rollback')}>
              回退至 {gw.version.previousVersion}
            </button>
          )}
        </div>

        <details style={{ marginTop: 12, fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--lt-fg-secondary)' }}>
            切换接入模式（接入本机已有 Magpie / 外部网关 / 停用网关）
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 10 }}>
            <input
              className="lt-input lt-mono"
              placeholder="外部网关 URL (如 http://127.0.0.1:3425)"
              value={extGwUrl}
              onChange={e => {
                setExtUrlsDirty(true);
                setExtGwUrl(e.target.value);
              }}
            />
            <input
              className="lt-input lt-mono"
              placeholder="外部管理 URL (可选 http://127.0.0.1:3430)"
              value={extWebUrl}
              onChange={e => {
                setExtUrlsDirty(true);
                setExtWebUrl(e.target.value);
              }}
            />
            <input
              type="password"
              className="lt-input lt-mono"
              placeholder="可选：外部 MAGPIE_WEB_KEY（仅写入服务端）"
              value={extWebKey}
              onChange={e => setExtWebKey(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="lt-btn"
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
                切换为外部 Magpie
              </button>
              <button
                className="lt-btn"
                disabled={busy}
                onClick={() => void runGatewayAction('configure', { config: { mode: 'disabled' } })}
              >
                仅用直连 API
              </button>
            </div>
          </div>
        </details>
      </div>

      <div className="lt-grid-2">
        {/* 2. Add Preset / Custom Provider */}
        <form className="lt-card" onSubmit={handleSaveProvider}>
          <h2 className="lt-card-title">
            <span>新增供应商或批量导入 API Key</span>
            <span className="lt-tag">支持多 Key 轮询</span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={{ fontSize: 11.5, color: 'var(--lt-fg-secondary)' }}>供应商预设 / 自定义协议</label>
              <select className="lt-select" value={vendorPreset} onChange={e => setVendorPreset(e.target.value)}>
                {presets.map(p => (
                  <option key={p.vendorId} value={p.vendorId}>
                    {p.displayName} ({p.defaultEndpointUrl || p.protocol})
                  </option>
                ))}
                <option value="custom">自定义 OpenAI / Responses / Anthropic / Gemini 供应商…</option>
              </select>
            </div>

            {vendorPreset === 'custom' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input className="lt-input lt-mono" placeholder="唯一标识 (如 relay-cn)" value={customId} onChange={e => setCustomId(e.target.value)} required />
                <input className="lt-input" placeholder="显示名称" value={customName} onChange={e => setCustomName(e.target.value)} />
                <select className="lt-select" value={customApi} onChange={e => setCustomApi(e.target.value as any)}>
                  <option value="chat">OpenAI Chat (/v1/chat/completions)</option>
                  <option value="responses">OpenAI Responses (/v1/responses)</option>
                  <option value="anthropic">Anthropic Messages (/v1/messages)</option>
                  <option value="gemini">Google Gemini (/v1beta)</option>
                </select>
                <input className="lt-input lt-mono" placeholder="接口基础地址 https://..." value={customUrl} onChange={e => setCustomUrl(e.target.value)} required />
              </div>
            )}

            <div>
              <label style={{ fontSize: 11.5, color: 'var(--lt-fg-secondary)' }}>
                API Key（支持粘贴单个或多个 Key，按换行/逗号自动拆分为多 Key 池；保存后立即清空输入框）
              </label>
              <textarea
                className="lt-textarea lt-mono"
                placeholder="sk-..."
                value={rawApiKey}
                onChange={e => setRawApiKey(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="lt-btn"
                disabled={busy || !gw.managementAuthenticated || (!rawApiKey.trim() && !canOmitApiKey)}
                onClick={() => void handlePreDiscover()}
              >
                预探测上游模型
              </button>
              <button
                type="submit"
                className="lt-btn lt-btn-primary"
                disabled={busy || !gw.managementAuthenticated || (!rawApiKey.trim() && !canOmitApiKey)}
              >
                保存供应商与密钥
              </button>
            </div>

            {!gw.managementAuthenticated && (
              <div style={{ fontSize: 11.5, color: 'var(--lt-warning)' }}>
                提示：点击上方「启动 LT 托管实例」（或为外部 Magpie 配置管理密钥）后即可在线增删供应商与多 Key。
              </div>
            )}

            {discoveredPreview.length > 0 && (
              <div style={{ fontSize: 11.5, padding: 8, background: 'var(--lt-bg-subtle)', borderRadius: 'var(--lt-radius-sm)' }}>
                <strong>探测到 {discoveredPreview.length} 个可用模型：</strong>{' '}
                <span className="lt-mono">{discoveredPreview.slice(0, 12).map(m => m.id).join(', ')}</span>
              </div>
            )}
          </div>

          {/* Native Magpie OAuth Passthrough */}
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--lt-border-subtle)' }}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
              复用 Magpie 既有订阅 / OAuth 登录（无需重复建设独立 OAuth）
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="lt-select" style={{ width: 190 }} value={oauthAgent} onChange={e => setOauthAgent(e.target.value)}>
                <option value="codex">OpenAI Codex 订阅 (codex)</option>
                <option value="claude">Anthropic Claude 订阅 (claude)</option>
                <option value="gemini">Google Gemini 订阅 (gemini)</option>
                <option value="copilot">GitHub Copilot (copilot)</option>
              </select>
              <button type="button" className="lt-btn" disabled={busy || !gw.managementAuthenticated} onClick={() => void handleStartOAuth()}>
                获取 Magpie 登录链接
              </button>
              {oauthSession && (
                <button type="button" className="lt-btn lt-btn-danger" disabled={busy} onClick={() => void handleCancelOAuth()}>
                  取消登录
                </button>
              )}
            </div>
            {oauthSession && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <div>
                  状态：<span className="lt-tag lt-mono">{oauthSession.state || 'waiting'}</span>
                  {oauthSession.code && (
                    <span className="lt-mono" style={{ marginLeft: 8 }}>设备码：{oauthSession.code}</span>
                  )}
                </div>
                {oauthSession.authUrl && (
                  <div>
                    授权地址：<a href={oauthSession.authUrl} target="_blank" rel="noreferrer" className="lt-mono">{oauthSession.authUrl}</a>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="lt-input lt-mono"
                    placeholder="粘贴浏览器完成登录后的 localhost 回调 URL…"
                    value={oauthCallbackUrl}
                    onChange={e => setOauthCallbackUrl(e.target.value)}
                  />
                  <button type="button" className="lt-btn lt-btn-primary" onClick={() => void handleSubmitOAuthCallback()}>
                    提交回调
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>

        {/* 3. Active Providers & Multi-Key Pool Inspector */}
        <div className="lt-card">
          <h2 className="lt-card-title">
            <span>已接入供应商与凭据池 ({bundle.providers.length})</span>
            <span className="lt-tag">四维身份严格分离</span>
          </h2>
          {bundle.providers.length === 0 ? (
            <div style={{ color: 'var(--lt-fg-muted)', fontSize: 12.5 }}>
              尚无已配置的供应商。可在左侧通过 Magpie 添加预设/自定义供应商，或在环境变量中配置 Solo-Key（如 <code>DEEPSEEK_API_KEY</code>）。
            </div>
          ) : (
            <div className="lt-table-wrap">
              <table className="lt-table">
                <thead>
                  <tr>
                    <th>供应商标识</th>
                    <th>来源 / 协议</th>
                    <th>凭据数 (脱敏)</th>
                    <th className="lt-right">模型</th>
                    <th className="lt-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.providers.map(p => (
                    <tr
                      key={p.providerId}
                      data-selected={p.providerId === activeProviderId}
                      onClick={() => setActiveProviderId(p.providerId)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <strong>{p.displayName}</strong>
                        <div className="lt-mono" style={{ fontSize: 11, color: 'var(--lt-fg-muted)' }}>{p.providerId}</div>
                      </td>
                      <td>
                        <span className="lt-tag">{p.sourceKind}</span>{' '}
                        <span className="lt-mono" style={{ fontSize: 11 }}>{p.protocol}</span>
                      </td>
                      <td className="lt-mono" style={{ fontSize: 11.5 }}>
                        {p.credentials.length} 项 · {p.credentials[0]?.maskedPreview || '无'}
                      </td>
                      <td className="lt-right">{p.enabledModelCount}</td>
                      <td className="lt-right" onClick={e => e.stopPropagation()}>
                        {p.sourceKind === 'magpie' && gw.managementAuthenticated && (
                          <div style={{ display: 'inline-flex', gap: 4 }}>
                            <button
                              className="lt-btn lt-btn-sm"
                              disabled={busy}
                              onClick={() => void handleMutateProvider('test-provider', { id: p.providerId })}
                            >
                              测速
                            </button>
                            <button
                              className="lt-btn lt-btn-sm"
                              disabled={busy}
                              onClick={() => void handleMutateProvider('refresh-models', { id: p.providerId })}
                            >
                              刷新模型
                            </button>
                            <button
                              className="lt-btn lt-btn-sm lt-btn-danger"
                              disabled={busy}
                              onClick={() => void handleMutateProvider('delete-provider', { id: p.providerId })}
                            >
                              移除
                            </button>
                          </div>
                        )}
                        {p.sourceKind === 'external-gateway' && bundle.capabilities.features.externalGateways && (
                          <button
                            className="lt-btn lt-btn-sm lt-btn-danger"
                            disabled={busy}
                            onClick={() =>
                              void runGatewayAction('remove-external', {
                                id: p.providerId.replace(/^ext:/, ''),
                              })
                            }
                          >
                            移除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Selected Provider Multi-Key Pool Management */}
          {selectedProvider && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--lt-border-strong)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong>凭据池明细：{selectedProvider.displayName}</strong>
                {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated && (
                  <select
                    className="lt-select"
                    style={{ width: 170, height: 28 }}
                    value={selectedProvider.keyRotation}
                    onChange={e =>
                      void handleMutateProvider('set-routing', {
                        id: selectedProvider.providerId,
                        keyRotation: e.target.value,
                      })
                    }
                  >
                    <option value="single" disabled>单凭据默认 (single)</option>
                    <option value="fill-first">顺位优先 (fill-first)</option>
                    <option value="round-robin">轮询均衡 (round-robin)</option>
                    <option value="least-used">最少调用 (least-used)</option>
                  </select>
                )}
              </div>

              {selectedProvider.credentials.map(cred => (
                <div
                  key={cred.credentialId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 8px',
                    background: 'var(--lt-bg-subtle)',
                    borderRadius: 'var(--lt-radius-sm)',
                    marginBottom: 6,
                    fontSize: 12,
                  }}
                >
                  <div>
                    <strong>{cred.label}</strong> {cred.primary && <span className="lt-seal">主 Key</span>}{' '}
                    <span className="lt-mono" style={{ color: 'var(--lt-fg-muted)' }}>{cred.maskedPreview}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--lt-fg-secondary)' }}>权重 {cred.weight}</span>
                  </div>
                  {selectedProvider.sourceKind === 'magpie' && cred.kind === 'api_key' && gw.managementAuthenticated && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {!cred.primary && (
                        <button
                          className="lt-btn lt-btn-sm"
                          onClick={() =>
                            void handleMutateProvider('mutate-key', {
                              providerId: selectedProvider.providerId,
                              credentialId: cred.credentialId,
                              keyAction: 'use',
                            })
                          }
                        >
                          设为主 Key
                        </button>
                      )}
                      <button
                        className="lt-btn lt-btn-sm"
                        onClick={() =>
                          void handleMutateProvider('mutate-key', {
                            providerId: selectedProvider.providerId,
                            credentialId: cred.credentialId,
                            keyAction: cred.enabled ? 'off' : 'on',
                          })
                        }
                      >
                        {cred.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        className="lt-btn lt-btn-sm lt-btn-danger"
                        onClick={() =>
                          void handleMutateProvider('mutate-key', {
                            providerId: selectedProvider.providerId,
                            credentialId: cred.credentialId,
                            keyAction: 'remove',
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                  )}
                  {selectedProvider.sourceKind === 'magpie' && cred.kind === 'oauth' && gw.managementAuthenticated && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {!cred.primary && (
                        <button
                          className="lt-btn lt-btn-sm"
                          onClick={() =>
                            void handleMutateProvider('mutate-login', {
                              providerId: selectedProvider.providerId,
                              loginAction: 'switch',
                              user: cred.label,
                            })
                          }
                        >
                          设为当前账号
                        </button>
                      )}
                      <button
                        className="lt-btn lt-btn-sm"
                        onClick={() =>
                          void handleMutateProvider('mutate-login', {
                            providerId: selectedProvider.providerId,
                            loginAction: cred.enabled ? 'off' : 'on',
                            user: cred.label,
                          })
                        }
                      >
                        {cred.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        className="lt-btn lt-btn-sm lt-btn-danger"
                        onClick={() =>
                          void handleMutateProvider('mutate-login', {
                            providerId: selectedProvider.providerId,
                            loginAction: 'forget',
                            user: cred.label,
                          })
                        }
                      >
                        退出
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input
                    className="lt-input"
                    style={{ width: 130 }}
                    placeholder="备注名 (如 Key 2)"
                    value={extraKeyName}
                    onChange={e => setExtraKeyName(e.target.value)}
                  />
                  <input
                    type="password"
                    className="lt-input lt-mono"
                    placeholder="追加新 API Key (sk-...)"
                    value={extraKeySecret}
                    onChange={e => setExtraKeySecret(e.target.value)}
                  />
                  <button
                    className="lt-btn lt-btn-primary"
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
                    + 追加 Key
                  </button>
                </div>
              )}
            </div>
          )}
          {bundle.capabilities.features.externalGateways && (
            <form
              onSubmit={handleSaveExternalGateway}
              style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--lt-border-subtle)' }}
            >
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>
                登记独立 OpenAI/Anthropic 兼容外部网关 (externalGateways)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                <input
                  className="lt-input lt-mono"
                  placeholder="网关标识 (如 local-vllm)"
                  value={extRelayId}
                  onChange={e => setExtRelayId(e.target.value)}
                  required
                />
                <input
                  className="lt-input"
                  placeholder="显示名称 (可选)"
                  value={extRelayName}
                  onChange={e => setExtRelayName(e.target.value)}
                />
                <input
                  className="lt-input lt-mono"
                  placeholder="接口地址 (如 http://127.0.0.1:8000/v1)"
                  value={extRelayEndpoint}
                  onChange={e => setExtRelayEndpoint(e.target.value)}
                  required
                />
                <select
                  className="lt-select"
                  value={extRelayProtocol}
                  onChange={e => setExtRelayProtocol(e.target.value as ProviderProtocol)}
                >
                  <option value="openai-chat">openai-chat</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="google-gemini">google-gemini</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="password"
                  className="lt-input lt-mono"
                  style={{ flex: 1, minWidth: 160 }}
                  placeholder="可选：网关 API Key（单向加密落盘）"
                  value={extRelayKey}
                  onChange={e => setExtRelayKey(e.target.value)}
                />
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                  <input
                    type="checkbox"
                    checked={extRelayKeyOptional}
                    onChange={e => setExtRelayKeyOptional(e.target.checked)}
                  />
                  免密钥内网网关
                </label>
                <button
                  type="submit"
                  className="lt-btn"
                  disabled={busy || !extRelayId.trim() || !extRelayEndpoint.trim()}
                >
                  保存外部网关
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
