import React, { useEffect, useState, useCallback } from 'react';
import { callLtApi, formatDurationMs, formatNumber, type HydratedBundle } from '../lib/api';
import { HeluoxuHorizonMark } from '../components/HeluoxuMark';

interface WorkbenchSessionItem {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  agentPreset: string | null;
  updatedAt: number | null;
  isTeam: boolean;
}

interface ReadableMessage {
  id: string;
  role: 'user' | 'assistant';
  timeMs: number | null;
  text: string;
  thinkingPreview?: string | null;
  model: string | null;
  usage?: {
    inputTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  toolCalls: Array<{ id: string; name: string }>;
}

export function WorkbenchView({
  bundle,
  onRefreshBundle,
  onNavigateTab,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
  onNavigateTab: (tab: string) => void;
}) {
  const [liveHost, setLiveHost] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ workspaceId: string; path: string; title?: string }>>([]);
  const [sessions, setSessions] = useState<WorkbenchSessionItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ReadableMessage[]>([]);
  const [newCwd, setNewCwd] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptMode, setPromptMode] = useState<'queue' | 'steer'>('queue');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const data = await callLtApi<{
        liveHost: boolean;
        workspaces: Array<{ workspaceId: string; path: string; title?: string }>;
        sessions: WorkbenchSessionItem[];
      }>('workbench/sessions');
      setLiveHost(data.liveHost);
      setWorkspaces(data.workspaces || []);
      setSessions(data.sessions || []);
      if (!selectedSessionId && data.sessions?.length > 0) {
        setSelectedSessionId(data.sessions[0].sessionId);
      }
    } catch (e: any) {
      setFeedback(e.message);
    }
  }, [selectedSessionId]);

  const loadTranscript = useCallback(async (sid: string) => {
    if (!sid) {
      setMessages([]);
      return;
    }
    try {
      const res = await callLtApi<{ messages: ReadableMessage[] }>('workbench/transcript', { sessionId: sid });
      setMessages(res.messages || []);
    } catch {}
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    void loadTranscript(selectedSessionId);
    if (!selectedSessionId) return;
    const timer = setInterval(() => {
      void loadTranscript(selectedSessionId);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedSessionId, loadTranscript]);

  const activeTeam =
    bundle.runtime.teams.find(t => t.sessionId === selectedSessionId || t.teamId === selectedSessionId) ||
    bundle.runtime.teams[0] ||
    null;

  async function handleCreateSession() {
    setBusy(true);
    setFeedback(null);
    try {
      const ws = workspaces[0];
      const created = await callLtApi<{ sessionId: string }>('workbench/create', {
        ...(newCwd.trim() ? { cwd: newCwd.trim() } : ws ? { workspaceId: ws.workspaceId } : {}),
        agentPreset: 'leaderteam',
      });
      await loadSessions();
      setSelectedSessionId(created.sessionId);
      setFeedback(`已创建新 LeaderTeam 会话：${created.sessionId}`);
    } catch (e: any) {
      setFeedback(`创建会话失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSessionId || !promptText.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      await callLtApi('workbench/prompt', {
        sessionId: selectedSessionId,
        text: promptText.trim(),
        mode: promptMode,
      });
      setPromptText('');
      await Promise.all([loadTranscript(selectedSessionId), onRefreshBundle()]);
    } catch (err: any) {
      setFeedback(`发送失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelTurn() {
    if (!selectedSessionId) return;
    setBusy(true);
    try {
      await callLtApi('workbench/cancel', { sessionId: selectedSessionId });
      setFeedback('已向当前会话发送中断请求（保留待处理队列）');
    } catch (err: any) {
      setFeedback(`中断失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {feedback && (
        <div className="lt-banner">
          <span>{feedback}</span>
          <button className="lt-btn lt-btn-sm" onClick={() => setFeedback(null)}>关闭</button>
        </div>
      )}

      <div className="lt-workbench-layout">
        {/* LEFT COLUMN: Workspaces & Sessions */}
        <aside className="lt-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="lt-card-title">
            <span>工程与会话</span>
            <button className="lt-btn lt-btn-sm" onClick={() => void loadSessions()}>刷新</button>
          </div>

          {bundle.capabilities.features.liveSessionRpc ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 10, borderBottom: '1px solid var(--lt-border-subtle)' }}>
              <input
                className="lt-input"
                placeholder={workspaces[0]?.path || '可选：工作区绝对路径'}
                value={newCwd}
                onChange={e => setNewCwd(e.target.value)}
              />
              <button className="lt-btn lt-btn-primary" disabled={busy} onClick={() => void handleCreateSession()}>
                + 新建 LeaderTeam 会话
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--lt-fg-muted)', paddingBottom: 8, borderBottom: '1px solid var(--lt-border-subtle)' }}>
              当前为独立伴侣模式（只读浏览历史会话账本；在 DSH Web 中打开 <code>/lt/</code> 可直接实时对话与发令）。
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', maxHeight: '64vh' }}>
            {sessions.length === 0 ? (
              <div style={{ color: 'var(--lt-fg-muted)', fontSize: 12, padding: '12px 0' }}>
                尚无会话记录。可新建会话或先在网关与模型池中完成配置。
              </div>
            ) : (
              sessions.map(s => {
                const selected = s.sessionId === selectedSessionId;
                return (
                  <button
                    key={s.sessionId}
                    onClick={() => setSelectedSessionId(s.sessionId)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      border: '1px solid var(--lt-border-subtle)',
                      borderRadius: 'var(--lt-radius-sm)',
                      background: selected ? 'var(--lt-bg-selected)' : 'transparent',
                      boxShadow: selected ? 'inset 2px 0 0 var(--lt-accent)' : 'none',
                      color: 'var(--lt-fg-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: selected ? 600 : 500, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || s.sessionId.slice(0, 18)}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 11, color: 'var(--lt-fg-muted)' }}>
                      <span className="lt-mono">{s.sessionId.slice(0, 12)}</span>
                      {s.isTeam && <span className="lt-seal">TEAM</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* CENTER COLUMN: Conversation Stream & Composer */}
        <section className="lt-card lt-card-authority" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 520 }}>
          <div>
            <div className="lt-card-title" style={{ paddingBottom: 10, borderBottom: '1px solid var(--lt-border-subtle)' }}>
              <div>
                <span>对话与工程流</span>
                {selectedSessionId && (
                  <span className="lt-mono" style={{ marginLeft: 10, fontSize: 11.5, color: 'var(--lt-fg-muted)', fontWeight: 400 }}>
                    {selectedSessionId}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {bundle.capabilities.frontendSwitch.available && bundle.capabilities.frontendSwitch.dshFrontendUrl && (
                  <a className="lt-btn lt-btn-sm" href={bundle.capabilities.frontendSwitch.dshFrontendUrl}>
                    在 DSH 原生前端查看同一会话 ↗
                  </a>
                )}
                {liveHost && selectedSessionId && (
                  <button className="lt-btn lt-btn-sm lt-btn-danger" disabled={busy} onClick={() => void handleCancelTurn()}>
                    中断当前回合
                  </button>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 0', maxHeight: '56vh', overflowY: 'auto' }}>
              {messages.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--lt-fg-muted)' }}>
                  <HeluoxuHorizonMark />
                  <div style={{ marginTop: 12, fontSize: 13 }}>
                    {selectedSessionId ? '当前会话暂无消息回执' : '请从左侧选择或新建一条工程会话'}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12 }}>
                    支持自然语言指令与内联控制指令（如 <code>最大并发 4</code>、<code>允许读取 /path</code>）
                  </div>
                </div>
              ) : (
                messages.map(m => (
                  <div
                    key={m.id}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 'var(--lt-radius-sm)',
                      background: m.role === 'user' ? 'var(--lt-bg-selected)' : 'var(--lt-bg-subtle)',
                      border: '1px solid var(--lt-border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 11, color: 'var(--lt-fg-muted)' }}>
                      <strong style={{ color: 'var(--lt-fg-primary)' }}>
                        {m.role === 'user' ? '用户指令 (User)' : '主导代理 (Leader / Assistant)'}
                      </strong>
                      <span className="lt-mono">
                        {m.model ? `${m.model} · ` : ''}
                        {m.usage?.totalTokens ? `${formatNumber(m.usage.totalTokens)} tok` : ''}
                      </span>
                    </div>
                    {m.thinkingPreview && (
                      <details style={{ marginBottom: 6, fontSize: 11.5, color: 'var(--lt-fg-secondary)' }}>
                        <summary style={{ cursor: 'pointer' }}>推理摘要 (Thinking)</summary>
                        <pre className="lt-mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', fontSize: 11 }}>
                          {m.thinkingPreview}
                        </pre>
                      </details>
                    )}
                    {m.text && (
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>{m.text}</div>
                    )}
                    {m.toolCalls.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {m.toolCalls.map(tc => (
                          <span key={tc.id} className="lt-tag lt-mono">⚙ {tc.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <form onSubmit={handleSendPrompt} style={{ borderTop: '1px solid var(--lt-border-subtle)', paddingTop: 12 }}>
            <textarea
              className="lt-textarea"
              placeholder={
                liveHost
                  ? '输入工程任务、评审意见或实时控制指令（支持「最大并发 N」、「允许读取 <路径>」）…'
                  : '独立伴侣模式下仅支持只读观察；通过 dsh web 打开 /lt/ 可直接发送实时指令'
              }
              disabled={!liveHost || !selectedSessionId || busy}
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <select
                  className="lt-select"
                  style={{ width: 150, height: 30 }}
                  value={promptMode}
                  onChange={e => setPromptMode(e.target.value as 'queue' | 'steer')}
                  disabled={!liveHost}
                >
                  <option value="queue">排队投递 (Queue)</option>
                  <option value="steer">即时引导 (Steer)</option>
                </select>
                <span style={{ fontSize: 11.5, color: 'var(--lt-fg-muted)' }}>
                  主导角色：<code className="lt-mono">{bundle.runtime.roleAssignments.leader?.route || '未配置'}</code>
                </span>
              </div>
              <button
                type="submit"
                className="lt-btn lt-btn-primary"
                disabled={!liveHost || !selectedSessionId || !promptText.trim() || busy}
              >
                {busy ? '提交中…' : '发送指令'}
              </button>
            </div>
          </form>
        </section>

        {/* RIGHT COLUMN: Real-Time Team & Rolling Frontier HUD */}
        <aside className="lt-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="lt-card-title">
            <span>团队实时态势</span>
            <button className="lt-btn lt-btn-sm" onClick={() => onNavigateTab('governance')}>详情 →</button>
          </div>

          {!activeTeam ? (
            <div style={{ color: 'var(--lt-fg-muted)', fontSize: 12.5 }}>
              当前暂无活跃 LeaderTeam 团队目录。在对话中启动复杂工程任务后，此处将实时展示滚动规划轴线、成员写域与治理状态。
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="lt-status">
                  <span
                    className={`lt-dot ${
                      activeTeam.status === 'active'
                        ? 'lt-dot-running'
                        : activeTeam.status === 'waiting_user' || activeTeam.status === 'paused'
                          ? 'lt-dot-error'
                          : 'lt-dot-ready'
                    }`}
                  />
                  <strong>任务 #{activeTeam.taskSeq}</strong> · {activeTeam.status.toUpperCase()}
                </span>
                <span className="lt-seal">
                  {activeTeam.status === 'paused' ? 'CONFERENCE' : activeTeam.status === 'waiting_user' ? 'ESCALATION' : 'AUTONOMOUS'}
                </span>
              </div>

              {activeTeam.timers && (
                <div
                  className="lt-num"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 8,
                    padding: '8px 10px',
                    background: 'var(--lt-bg-subtle)',
                    borderRadius: 'var(--lt-radius-sm)',
                    fontSize: 11.5,
                  }}
                >
                  <div>总跨度: <strong>{formatDurationMs(activeTeam.timers.projectWallMs)}</strong></div>
                  <div>累计活跃: <strong>{formatDurationMs(activeTeam.timers.projectActiveMs)}</strong></div>
                  <div>本轮耗时: <strong>{formatDurationMs(activeTeam.timers.taskWallMs)}</strong></div>
                  <div>时间压力: <strong>{activeTeam.timers.timePressure.toUpperCase()}</strong></div>
                </div>
              )}

              <div>
                <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--lt-fg-muted)', marginBottom: 8 }}>
                  河洛轴线 · 滚动规划阶段 ({activeTeam.frontierStages.length})
                </div>
                {activeTeam.frontierStages.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--lt-fg-muted)' }}>尚无已登记的滚动阶段契约</div>
                ) : (
                  <div className="lt-rail-list">
                    {activeTeam.frontierStages.map(st => (
                      <div key={st.stageId} className="lt-rail-item">
                        <span className="lt-rail-node" data-state={st.executionState} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 12 }}>
                          <strong className="lt-mono">{st.stageId}</strong>
                          <span className="lt-tag">{st.executionState}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--lt-fg-secondary)', marginTop: 3 }}>{st.title}</div>
                        {st.writeScope.length > 0 && (
                          <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--lt-fg-muted)' }} className="lt-mono">
                            写域: {st.writeScope.slice(0, 2).join(', ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--lt-fg-muted)', marginBottom: 6 }}>
                  子智能体成员 ({activeTeam.members.length}) · 并发上限 {bundle.runtime.scheduler.effectiveCap ?? bundle.runtime.scheduler.maxActiveMembers}
                </div>
                {activeTeam.members.slice(0, 6).map(m => (
                  <div
                    key={m.memberId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 0',
                      borderBottom: '1px solid var(--lt-border-subtle)',
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <strong>{m.name}</strong>
                      <div className="lt-mono" style={{ fontSize: 10.5, color: 'var(--lt-fg-muted)' }}>
                        {m.configuredModel} ({m.effort})
                      </div>
                    </div>
                    <span className="lt-tag">{m.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
