import React, { useEffect, useState } from 'react';
import { callLtApi, type HydratedBundle } from '../lib/api';
import { Icon, type IconName } from './Icon';

export interface OnboardingModalProps {
  open: boolean;
  bundle: HydratedBundle;
  onClose: () => void;
  onRefreshBundle: () => Promise<void>;
  onOpenSession: (sessionId: string) => void;
  onNotify?: (message: string, icon?: IconName) => void;
}

export function OnboardingModal({
  open,
  bundle,
  onClose,
  onRefreshBundle,
  onOpenSession,
  onNotify,
}: OnboardingModalProps) {
  const ob = bundle.onboarding;
  const presets = ob?.providerPresets ?? [];
  const collabPresets = ob?.collabPresets ?? [];
  const starterTasks = ob?.starterTasks ?? [];

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [providerId, setProviderId] = useState<string>(
    ob?.selectedProviderId || presets[0]?.id || 'deepseek',
  );
  const [apiKey, setApiKey] = useState<string>('');
  const [customBaseURL, setCustomBaseURL] = useState<string>('');
  const [verifyConn, setVerifyConn] = useState<boolean>(false);
  const [collabPresetId, setCollabPresetId] = useState<string>(
    ob?.selectedCollabPreset || collabPresets[0]?.id || 'balanced-team',
  );
  const [workspaceCwd, setWorkspaceCwd] = useState<string>(ob?.defaultWorkspace || '');
  const [selectedTaskId, setSelectedTaskId] = useState<string>(
    starterTasks[0]?.id || 'project-tour',
  );
  const [customPrompt, setCustomPrompt] = useState<string>(starterTasks[0]?.prompt || '');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (ob?.defaultWorkspace && !workspaceCwd) {
      setWorkspaceCwd(ob.defaultWorkspace);
    }
    const firstTask = starterTasks.find(t => t.id === selectedTaskId) || starterTasks[0];
    if (firstTask && !customPrompt) {
      setCustomPrompt(firstTask.prompt);
    }
  }, [open, ob?.defaultWorkspace]);

  if (!open) return null;

  const activeProvider = presets.find(p => p.id === providerId) || presets[0];
  const alreadyHasModel = Boolean(ob?.steps?.modelConnected);

  async function handleSaveStep1And2() {
    setBusy(true);
    setError(null);
    setInfoMsg(null);
    try {
      if (!apiKey.trim() && !alreadyHasModel) {
        throw new Error('请粘贴有效的模型 API Key，以便为您自动生成团队配置。');
      }
      await callLtApi('onboarding', {
        action: 'apply-quick-setup',
        providerId,
        apiKey: apiKey.trim(),
        customBaseURL: customBaseURL.trim(),
        collabPresetId,
        verifyConnectivity: verifyConn && Boolean(apiKey.trim()),
      });
      await onRefreshBundle();
      setApiKey('');
      setInfoMsg('模型与团队协作预设已保存生效！现在可以创建您的第一个任务。');
      setStep(3);
    } catch (e: any) {
      setError(e?.message || '保存模型配置失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateFirstTask() {
    setBusy(true);
    setError(null);
    try {
      const chosenCollab = collabPresets.find(c => c.id === collabPresetId);
      const initialMode = chosenCollab?.defaultSessionMode === 'single' ? 'single' : 'team';
      const promptText = customPrompt.trim();
      if (!promptText) {
        throw new Error('请输入任务描述或选择上方任一示例任务模板。');
      }

      if (!bundle.capabilities.features.liveSessionRpc) {
        await callLtApi('onboarding', { action: 'complete' });
        await onRefreshBundle();
        if (onNotify) {
          onNotify('已完成新手配置！当前为独立配置模式，请在 DSH 客户端中发起对话。', 'check');
        }
        onClose();
        return;
      }

      const created = await callLtApi<any>('workbench/create', {
        cwd: workspaceCwd.trim() || undefined,
        preset: 'leaderteam',
        mode: initialMode,
      });
      const sid = created?.session?.sessionId || created?.sessionId || '';
      if (!sid) {
        throw new Error('创建会话未返回有效的 sessionId');
      }
      await callLtApi('workbench/prompt', {
        sessionId: sid,
        text: promptText,
      });
      await callLtApi('onboarding', {
        action: 'complete',
        firstSessionId: sid,
      });
      await onRefreshBundle();
      if (onNotify) {
        onNotify('已创建首个任务会话并开始执行！', 'check');
      }
      onOpenSession(sid);
      onClose();
    } catch (e: any) {
      setError(e?.message || '创建首个任务失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss() {
    try {
      await callLtApi('onboarding', { action: 'dismiss' });
      await onRefreshBundle();
    } catch {}
    onClose();
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Open Leader Team (OLT) 新手引导向导"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(12, 18, 22, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 720,
          maxHeight: '90vh',
          overflow: 'auto',
          padding: '24px 28px',
          background: 'var(--lt-surface, #fff)',
          boxShadow: '0 20px 48px rgba(0,0,0,0.28)',
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <span className="t-overline">快速上手 · 零命令行引导</span>
            <h2 style={{ margin: '2px 0 0', fontSize: 20 }}>欢迎使用 Open Leader Team (OLT)</h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void handleDismiss()}
            title="稍后再说（可随时从底部状态栏重新打开）"
          >
            跳过引导
          </button>
        </div>

        {/* Step Indicator */}
        <div className="row" style={{ gap: 8, marginBottom: 18 }}>
          {[
            [1, '1. 接入模型 Key'],
            [2, '2. 选择团队模式'],
            [3, '3. 启动首个任务'],
          ].map(([num, label]) => (
            <button
              key={num}
              type="button"
              className={`btn btn-sm ${step === num ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStep(num as 1 | 2 | 3)}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div className="callout danger" style={{ marginBottom: 14 }}>
            <Icon name="alert" />
            <span className="grow">{error}</span>
          </div>
        )}
        {infoMsg && (
          <div className="callout info" style={{ marginBottom: 14 }}>
            <Icon name="check" />
            <span className="grow">{infoMsg}</span>
          </div>
        )}

        {step === 1 && (
          <div className="col" style={{ gap: 14 }}>
            <p className="t-small" style={{ margin: 0 }}>
              无需设置环境变量或编辑配置文件：选择一个常用模型服务商并粘贴 API Key，LT 将自动为您配置全部协作角色并安全存储于本地凭据库。
            </p>
            {alreadyHasModel && (
              <div className="callout info">
                <Icon name="check" />
                <span className="grow">
                  已检测到本机可用模型或网关配置
                  {ob?.detectedEnvVars && ob.detectedEnvVars.length > 0
                    ? `（${ob.detectedEnvVars.join(', ')}）`
                    : ''}
                  ！您可以直接点击“下一步”，或在此更换新的 API Key。
                </span>
              </div>
            )}

            <div className="col" style={{ gap: 6 }}>
              <label className="t-small" style={{ fontWeight: 600 }}>
                选择模型厂商
              </label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {presets.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className={`btn ${providerId === p.id ? 'btn-primary' : ''}`}
                    onClick={() => setProviderId(p.id)}
                  >
                    {p.displayName}
                  </button>
                ))}
              </div>
              {activeProvider && (
                <span className="t-meta">
                  {activeProvider.guideHint}（主力模型：<code>{activeProvider.reasoningLabel}</code>，轻量模型：<code>{activeProvider.chatLabel}</code>）
                </span>
              )}
            </div>

            <div className="col" style={{ gap: 6 }}>
              <label className="t-small" style={{ fontWeight: 600 }}>
                API Key {alreadyHasModel ? '（已配置，留空保持不变）' : ''}
              </label>
              <input
                type="password"
                className="input"
                placeholder={activeProvider?.keyPlaceholder || 'sk-...'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
              />
            </div>

            <details>
              <summary className="t-meta" style={{ cursor: 'pointer' }}>
                高级选项：自定义接口地址（Base URL）或保存前连通性测试
              </summary>
              <div className="col" style={{ gap: 8, marginTop: 8 }}>
                <input
                  type="text"
                  className="input"
                  placeholder={activeProvider?.defaultBaseURL || 'https://...'}
                  value={customBaseURL}
                  onChange={e => setCustomBaseURL(e.target.value)}
                />
                <label className="row t-small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={verifyConn}
                    onChange={e => setVerifyConn(e.target.checked)}
                  />
                  保存前联网验证该 API Key 是否有效
                </label>
              </div>
            </details>

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(2)}
              >
                下一步：选择团队模式
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="col" style={{ gap: 12 }}>
            <p className="t-small" style={{ margin: 0 }}>
              选择最适合您当前习惯的工作方式（后续在任意会话内均可随时一键切换 <code>Team</code> 与 <code>Single</code> 模式）：
            </p>
            <div className="col" style={{ gap: 10 }}>
              {collabPresets.map(cp => (
                <div
                  key={cp.id}
                  onClick={() => setCollabPresetId(cp.id)}
                  className="card card-pad"
                  style={{
                    cursor: 'pointer',
                    border:
                      collabPresetId === cp.id
                        ? '2px solid var(--lt-accent, #2a657c)'
                        : '1px solid var(--lt-border-subtle)',
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <b className="t-small">{cp.label}</b>
                    <span className={`mode-badge ${cp.defaultSessionMode}`}>
                      默认 {cp.defaultSessionMode === 'single' ? 'Single' : 'Team'}
                    </span>
                  </div>
                  <span className="t-meta">{cp.summary}</span>
                </div>
              ))}
            </div>

            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => setStep(1)}>
                上一步
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleSaveStep1And2()}
              >
                {busy ? '正在应用配置…' : '保存配置并进入最后一步'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="col" style={{ gap: 12 }}>
            <p className="t-small" style={{ margin: 0 }}>
              挑选一个开箱任务模板（或输入您自己的需求），点击按钮即可自动选好 LeaderTeam 预设并开始执行：
            </p>

            <div className="col" style={{ gap: 8 }}>
              {starterTasks.map(t => (
                <div
                  key={t.id}
                  onClick={() => {
                    setSelectedTaskId(t.id);
                    setCustomPrompt(t.prompt);
                  }}
                  className="card card-pad"
                  style={{
                    cursor: 'pointer',
                    border:
                      selectedTaskId === t.id
                        ? '2px solid var(--lt-accent, #2a657c)'
                        : '1px solid var(--lt-border-subtle)',
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <b className="t-small">{t.title}</b>
                    <span className={`mode-badge ${t.recommendedMode}`}>
                      推荐 {t.recommendedMode === 'single' ? 'Single' : 'Team'}
                    </span>
                  </div>
                  <span className="t-meta">{t.description}</span>
                </div>
              ))}
            </div>

            {bundle.capabilities.features.liveSessionRpc && (
              <div className="col" style={{ gap: 6 }}>
                <label className="t-small" style={{ fontWeight: 600 }}>
                  工作区目录（留空则使用宿主默认工作目录）
                </label>
                <input
                  type="text"
                  className="input"
                  value={workspaceCwd}
                  onChange={e => setWorkspaceCwd(e.target.value)}
                  placeholder="例如当前项目文件夹路径"
                />
              </div>
            )}

            <div className="col" style={{ gap: 6 }}>
              <label className="t-small" style={{ fontWeight: 600 }}>
                首个任务内容（可自由修改）
              </label>
              <textarea
                className="input"
                rows={3}
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
              />
            </div>

            <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <button type="button" className="btn" onClick={() => setStep(2)}>
                上一步
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleCreateFirstTask()}
              >
                {busy
                  ? '正在创建会话…'
                  : bundle.capabilities.features.liveSessionRpc
                    ? '创建会话并发送第一个任务'
                    : '完成新手引导'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
