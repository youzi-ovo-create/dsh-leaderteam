import React, { useState } from 'react';
import { callLtApi, type HydratedBundle } from '../lib/api';

export function ProvidersView({
  bundle,
  onRefreshBundle,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
}) {
  const gw = bundle.gateway;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // External / Managed gateway config inputs (write-only webKey!)
  const [extGwUrl, setExtGwUrl] = useState(gw.gatewayUrl || 'http://127.0.0.1:3425');
  const [extWebUrl, setExtWebUrl] = useState(gw.webAdminUrl || 'http://127.0.0.1:3430');
  const [extWebKey, setExtWebKey] = useState('');

  // Add Provider form
  const [vendorPreset, setVendorPreset] = useState(bundle.providerPresets[0]?.vendorId || 'deepseek');
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
  const [oauthSession, setOauthSession] = useState<{ id: string; authUrl?: string; status?: string } | null>(null);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState('');

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
      } else {
        setMessage(`网关操作「${action}」已完成（当前状态：${res.status?.state}）`);
      }
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
      const probe =
        vendorPreset === 'custom'
          ? { [customApi]: customUrl.trim(), key: rawApiKey.trim() }
          : { preset: vendorPreset, key: rawApiKey.trim() };
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
      const spec =
        vendorPreset === 'custom'
          ? {
              new: true,
              id: customId.trim(),
              name: customName.trim() || customId.trim(),
              [customApi]: customUrl.trim(),
              baseAPI: customApi,
              key: rawApiKey.trim(),
            }
          : {
              new: true,
              preset: vendorPreset,
              key: rawApiKey.trim(),
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
        setMessage(
          first?.ok
            ? `连通性测试通过（HTTP ${first.status} · 延迟 ${first.latencyMs}ms）`
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
      const res = await callLtApi<{ operationResult: { id: string; authUrl?: string; url?: string; status?: string } }>(
        'providers/mutate',
        { operation: 'oauth-start', agent: oauthAgent },
      );
      const op = res.operationResult;
      setOauthSession({ id: op.id, authUrl: op.authUrl || op.url, status: op.status });
      setMessage(`已通过 Magpie 原生机制发起 ${oauthAgent} 登录引导`);
    } catch (e: any) {
      setError(`发起 OAuth 失败：${e.message}`);
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
      setMessage('OAuth 回调已交由 Magpie 完成认证');
      await onRefreshBundle();
    } catch (e: any) {
      setError(`提交回调失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const selectedProvider = bundle.providers.find(p => p.providerId === activeProviderId) || null;

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
            <input className="lt-input lt-mono" placeholder="外部网关 URL (如 http://127.0.0.1:3425)" value={extGwUrl} onChange={e => setExtGwUrl(e.target.value)} />
            <input className="lt-input lt-mono" placeholder="外部管理 URL (可选 http://127.0.0.1:3430)" value={extWebUrl} onChange={e => setExtWebUrl(e.target.value)} />
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
                {bundle.providerPresets.map(p => (
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
                disabled={busy || !gw.managementAuthenticated || !rawApiKey.trim()}
                onClick={() => void handlePreDiscover()}
              >
                预探测上游模型
              </button>
              <button
                type="submit"
                className="lt-btn lt-btn-primary"
                disabled={busy || !gw.managementAuthenticated || !rawApiKey.trim()}
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
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="lt-select" style={{ width: 180 }} value={oauthAgent} onChange={e => setOauthAgent(e.target.value)}>
                <option value="codex">OpenAI Codex 订阅</option>
                <option value="claude-code">Claude Code 订阅</option>
                <option value="copilot">GitHub Copilot</option>
                <option value="gemini-cli">Gemini CLI</option>
              </select>
              <button type="button" className="lt-btn" disabled={busy || !gw.managementAuthenticated} onClick={() => void handleStartOAuth()}>
                获取 Magpie 登录链接
              </button>
            </div>
            {oauthSession && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
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
        </div>
      </div>
    </div>
  );
}
