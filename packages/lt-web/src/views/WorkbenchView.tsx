import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  LtApiError,
  callLtApi,
  fetchWorkbenchSessionMode,
  formatDurationMs,
  formatNumber,
  switchWorkbenchSessionMode,
  type HydratedBundle,
} from '../lib/api';
import { HeluoxuHorizonMark } from '../components/HeluoxuMark';
import type { ExecutionMode, SessionModeSnapshot } from '../types/lt-public-v1';

interface WorkbenchSessionItem {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  agentPreset: string | null;
  updatedAt: number | null;
  isTeam: boolean;
  executionMode?: ExecutionMode;
  isLtSession?: boolean;
  canSwitchMode?: boolean;
  modeBusyReason?: string | null;
  modeState?: SessionModeSnapshot;
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

const MODE_BEHAVIOR_HINT: Record<ExecutionMode, string> = {
  team: 'Team：领队编排 + 子代理并发 + 安全门/双评审',
  single: 'Single：主代理直接读写与命令 + 安全门守护 · 零团队开销',
};

export function isStaleModeSnapshot(
  prev: SessionModeSnapshot | null | undefined,
  next: SessionModeSnapshot | null | undefined,
): boolean {
  if (!prev || !next) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (
    Number.isInteger(prev.switchCount)
    && Number.isInteger(next.switchCount)
    && next.switchCount < prev.switchCount
  ) {
    return true;
  }
  return false;
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
  const dualModeEnabled = bundle.capabilities.features.inSessionDualMode === true;

  const [liveHost, setLiveHost] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ workspaceId: string; path: string; title?: string }>>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [sessions, setSessions] = useState<WorkbenchSessionItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ReadableMessage[]>([]);
  const [passiveRunning, setPassiveRunning] = useState(false);
  const [modeState, setModeState] = useState<SessionModeSnapshot | null>(null);
  const [switchingSessionIds, setSwitchingSessionIds] = useState<Record<string, boolean>>({});
  const [modeError, setModeError] = useState<string | null>(null);
  const [initialMode, setInitialMode] = useState<ExecutionMode>('team');
  const [newCwd, setNewCwd] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptMode, setPromptMode] = useState<'queue' | 'steer'>('queue');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const selectedSessionIdRef = useRef<string>(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const transcriptReqSeqRef = useRef<number>(0);
  const modeMutationEpochRef = useRef<number>(0);
  const prevSelectedSessionRef = useRef<string>(selectedSessionId);

  const syncModeSnapshotIntoSessionList = useCallback((snap: SessionModeSnapshot) => {
    setSessions(prev =>
      prev.map(item => {
        if (item.sessionId !== snap.sessionId) return item;
        if (isStaleModeSnapshot(item.modeState, snap)) return item;
        return {
          ...item,
          executionMode: snap.mode,
          isLtSession: snap.isLtSession,
          canSwitchMode: snap.canSwitch,
          modeBusyReason: snap.busyReason,
          modeState: snap,
        };
      }),
    );
  }, []);

  const applyModeSnapshot = useCallback((snap: SessionModeSnapshot) => {
    setModeState(prev => (isStaleModeSnapshot(prev, snap) ? prev : snap));
  }, []);

  const loadSessions = useCallback(async () => {
    const modeEpoch = modeMutationEpochRef.current;
    try {
      const data = await callLtApi<{
        liveHost: boolean;
        workspaces: Array<{ workspaceId: string; path: string; title?: string }>;
        sessions: WorkbenchSessionItem[];
      }>('workbench/sessions');
      setLiveHost(data.liveHost);
      const wsList = data.workspaces || [];
      setWorkspaces(wsList);
      if (!selectedWorkspaceId && wsList.length > 0) {
        setSelectedWorkspaceId(wsList[0].workspaceId);
      }
      const nextSessions = data.sessions || [];
      const epochStale = modeEpoch !== modeMutationEpochRef.current;
      setSessions(prev => {
        const prevById = new Map(prev.map(item => [item.sessionId, item]));
        return nextSessions.map(item => {
          const existing = prevById.get(item.sessionId);
          if (!existing) return item;
          if (epochStale || isStaleModeSnapshot(existing.modeState, item.modeState)) {
            const keepSnap = existing.modeState ?? item.modeState;
            return {
              ...item,
              executionMode: existing.executionMode ?? item.executionMode,
              isLtSession: existing.isLtSession ?? item.isLtSession,
              canSwitchMode: existing.canSwitchMode ?? item.canSwitchMode,
              modeBusyReason: existing.modeBusyReason !== undefined ? existing.modeBusyReason : item.modeBusyReason,
              ...(keepSnap ? { modeState: keepSnap } : {}),
            };
          }
          return item;
        });
      });
      const curSelected = selectedSessionIdRef.current;
      const activeSid = curSelected || (nextSessions.length > 0 ? nextSessions[0].sessionId : '');
      if (!curSelected && activeSid) {
        selectedSessionIdRef.current = activeSid;
        setSelectedSessionId(activeSid);
      }
      if (!epochStale && activeSid && activeSid === selectedSessionIdRef.current) {
        const matched = nextSessions.find(s => s.sessionId === activeSid);
        if (matched?.modeState) {
          applyModeSnapshot(matched.modeState);
        }
      }
    } catch (e: any) {
      setFeedback(e.message);
    }
  }, [selectedWorkspaceId, applyModeSnapshot]);

  const loadTranscript = useCallback(async (sid: string) => {
    const reqSeq = ++transcriptReqSeqRef.current;
    const modeEpoch = modeMutationEpochRef.current;
    if (!sid) {
      if (selectedSessionIdRef.current === '') {
        setMessages([]);
        setPassiveRunning(false);
        setModeState(null);
      }
      return;
    }
    try {
      const res = await callLtApi<{
        messages: ReadableMessage[];
        passiveState?: { running?: boolean; busy?: boolean; turnRunning?: boolean; status?: string } | null;
        modeState?: SessionModeSnapshot | null;
      }>('workbench/transcript', { sessionId: sid });

      const modeEpochMatches = modeEpoch === modeMutationEpochRef.current;
      if (res.modeState && modeEpochMatches) {
        syncModeSnapshotIntoSessionList(res.modeState);
      }
      if (sid !== selectedSessionIdRef.current || reqSeq !== transcriptReqSeqRef.current) {
        return;
      }

      setMessages(res.messages || []);
      const ps = res.passiveState;
      setPassiveRunning(
        Boolean(ps && (ps.running === true || ps.busy === true || ps.turnRunning === true || ps.status === 'running')),
      );
      if (res.modeState) {
        if (modeEpochMatches) {
          applyModeSnapshot(res.modeState);
        }
      } else if (dualModeEnabled && modeEpochMatches) {
        try {
          const fallbackEpoch = modeMutationEpochRef.current;
          const modeRes = await fetchWorkbenchSessionMode(sid);
          if (
            modeRes.modeState
            && fallbackEpoch === modeMutationEpochRef.current
            && modeEpoch === modeMutationEpochRef.current
          ) {
            syncModeSnapshotIntoSessionList(modeRes.modeState);
            if (sid === selectedSessionIdRef.current && reqSeq === transcriptReqSeqRef.current) {
              applyModeSnapshot(modeRes.modeState);
            }
          }
        } catch {}
      }
    } catch {
      if (sid === selectedSessionIdRef.current && reqSeq === transcriptReqSeqRef.current) {
        setPassiveRunning(false);
      }
    }
  }, [dualModeEnabled, syncModeSnapshotIntoSessionList, applyModeSnapshot]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
    setModeError(null);
    const matched = sessions.find(s => s.sessionId === selectedSessionId);
    if (prevSelectedSessionRef.current !== selectedSessionId) {
      prevSelectedSessionRef.current = selectedSessionId;
      setMessages([]);
      setPassiveRunning(Boolean(matched?.modeState?.activeTurn));
      setModeState(matched?.modeState ?? null);
    } else if (matched?.modeState) {
      applyModeSnapshot(matched.modeState);
    }
    void loadTranscript(selectedSessionId);
    if (!selectedSessionId) return;
    const timer = setInterval(() => {
      void loadTranscript(selectedSessionId);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedSessionId, loadTranscript, applyModeSnapshot]);

  const selectedSession = sessions.find(s => s.sessionId === selectedSessionId) || null;
  const effectiveModeState =
    modeState && modeState.sessionId === selectedSessionId
      ? modeState
      : selectedSession?.modeState ?? null;
  const isLtSession = effectiveModeState
    ? effectiveModeState.isLtSession
    : selectedSession
      ? selectedSession.isLtSession !== false
      : true;
  const currentMode: ExecutionMode =
    dualModeEnabled && (effectiveModeState?.mode ?? selectedSession?.executionMode) === 'single'
      ? 'single'
      : 'team';
  const switchingMode = Boolean(selectedSessionId && switchingSessionIds[selectedSessionId]);
  const isSwitchLockedByBusy =
    sending || busy || switchingMode || passiveRunning || effectiveModeState?.canSwitch === false;
  const switchLockReason = !isLtSession
    ? '当前为 DSH 原生预设会话（Single/Team 仅作用于 LT 会话）'
    : isSwitchLockedByBusy
      ? effectiveModeState?.busyReason || '当前回合正在执行，仅允许在空闲时切换模式'
      : null;

  const matchedSessionTeam = selectedSessionId
    ? bundle.runtime.teams.find(t => (t.sessionId || t.teamId) === selectedSessionId) || null
    : null;
  const activeTeam =
    isLtSession && currentMode === 'team'
      ? (matchedSessionTeam || (!selectedSessionId ? bundle.runtime.teams[0] || null : null))
      : null;

  async function handleSwitchMode(targetMode: ExecutionMode) {
    const targetSid = selectedSessionIdRef.current || selectedSessionId;
    if (!dualModeEnabled || !targetSid || !isLtSession || isSwitchLockedByBusy || targetMode === currentMode) {
      return;
    }
    ++modeMutationEpochRef.current;
    ++transcriptReqSeqRef.current;
    setSwitchingSessionIds(prev => ({ ...prev, [targetSid]: true }));
    setModeError(null);
    try {
      const res = await switchWorkbenchSessionMode(targetSid, targetMode);
      ++modeMutationEpochRef.current;
      ++transcriptReqSeqRef.current;
      syncModeSnapshotIntoSessionList(res.modeState);
      if (targetSid === selectedSessionIdRef.current) {
        applyModeSnapshot(res.modeState);
        setFeedback(
          `已切换会话执行模式为 ${res.modeState.mode === 'single' ? 'Single 单代理直执' : 'Team 团队协作'}（0 次模型调用）`,
        );
      }
    } catch (err: any) {
      ++modeMutationEpochRef.current;
      ++transcriptReqSeqRef.current;
      const apiErr = err instanceof LtApiError ? err : null;
      const latestSnap = apiErr?.details?.modeState as SessionModeSnapshot | undefined;
      if (latestSnap && latestSnap.sessionId === targetSid) {
        syncModeSnapshotIntoSessionList(latestSnap);
        if (targetSid === selectedSessionIdRef.current) {
          applyModeSnapshot(latestSnap);
        }
      }
      if (targetSid === selectedSessionIdRef.current) {
        const codePrefix = apiErr?.code ? `[${apiErr.code}] ` : '';
        setModeError(`切换执行模式失败：${codePrefix}${err?.message || '未知错误'}`);
      }
    } finally {
      setSwitchingSessionIds(prev => {
        const next = { ...prev };
        delete next[targetSid];
        return next;
      });
    }
  }

  async function handleCreateSession() {
    ++modeMutationEpochRef.current;
    ++transcriptReqSeqRef.current;
    setBusy(true);
    setFeedback(null);
    setModeError(null);
    try {
      const trimmedCwd = newCwd.trim();
      const matchedWs = trimmedCwd
        ? workspaces.find(w => w.path === trimmedCwd)
        : workspaces.find(w => w.workspaceId === selectedWorkspaceId) || workspaces[0];
      const locationSpec = matchedWs && (!trimmedCwd || matchedWs.path === trimmedCwd) && selectedWorkspaceId !== '__custom__'
        ? { workspaceId: matchedWs.workspaceId }
        : trimmedCwd
          ? { cwd: trimmedCwd }
          : matchedWs
            ? { workspaceId: matchedWs.workspaceId }
            : {};
      const created = await callLtApi<{
        sessionId: string;
        executionMode?: ExecutionMode;
        modeState?: SessionModeSnapshot;
      }>('workbench/create', {
        ...locationSpec,
        agentPreset: 'leaderteam',
        ...(dualModeEnabled ? { executionMode: initialMode } : {}),
      });
      ++modeMutationEpochRef.current;
      ++transcriptReqSeqRef.current;
      if (created.modeState) {
        setModeState(created.modeState);
        syncModeSnapshotIntoSessionList(created.modeState);
      }
      selectedSessionIdRef.current = created.sessionId;
      await loadSessions();
      setSelectedSessionId(created.sessionId);
      if (dualModeEnabled) {
        const createdMode = created.modeState?.mode ?? created.executionMode ?? initialMode;
        setFeedback(
          `已创建新 LeaderTeam 会话：${created.sessionId}（初始模式：${createdMode === 'single' ? 'Single 单代理直执' : 'Team 团队协作'}）`,
        );
      } else {
        setFeedback(`已创建新 LeaderTeam 会话：${created.sessionId}`);
      }
    } catch (e: any) {
      ++modeMutationEpochRef.current;
      ++transcriptReqSeqRef.current;
      setFeedback(`创建会话失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSessionId || !promptText.trim()) return;
    setBusy(true);
    setSending(true);
    setFeedback(null);
    setModeError(null);
    try {
      await callLtApi('workbench/prompt', {
        sessionId: selectedSessionId,
        text: promptText.trim(),
        mode: promptMode,
      });
      setPromptText('');
      await Promise.all([loadTranscript(selectedSessionId), loadSessions(), onRefreshBundle()]);
    } catch (err: any) {
      setFeedback(`发送失败：${err.message}`);
    } finally {
      setSending(false);
      setBusy(false);
    }
  }

  async function handleCancelTurn() {
    if (!selectedSessionId) return;
    setBusy(true);
    try {
      await callLtApi('workbench/cancel', { sessionId: selectedSessionId });
      setFeedback('已向当前会话发送中断请求（保留待处理队列）');
      await loadTranscript(selectedSessionId);
    } catch (err: any) {
      setFeedback(`中断失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function renderModeSegmentedControl(ariaLabel: string) {
    const disabledAll = !selectedSessionId || !isLtSession || isSwitchLockedByBusy;
    return (
      <div
        className="lt-mode-segment"
        role="group"
        aria-label={ariaLabel}
        title={switchLockReason || '会话空闲时可零模型调用热切换 Single / Team 执行模式'}
      >
        <button
          type="button"
          className="lt-mode-segment-btn"
          aria-pressed={isLtSession && currentMode === 'team'}
          disabled={disabledAll}
          onClick={() => void handleSwitchMode('team')}
        >
          Team 团队协作
        </button>
        <button
          type="button"
          className="lt-mode-segment-btn"
          aria-pressed={isLtSession && currentMode === 'single'}
          disabled={disabledAll}
          onClick={() => void handleSwitchMode('single')}
        >
          Single 单代理直执
        </button>
      </div>
    );
  }

  return (
    <div>
      {feedback && (
        <div className="lt-banner">
          <span>{feedback}</span>
          <button className="lt-btn lt-btn-sm" onClick={() => setFeedback(null)}>关闭</button>
        </div>
      )}

      {modeError && (
        <div className="lt-banner lt-banner-danger" role="alert">
          <span>{modeError}</span>
          <button className="lt-btn lt-btn-sm" onClick={() => setModeError(null)}>关闭</button>
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
              {workspaces.length > 0 && (
                <select
                  className="lt-select"
                  aria-label="选择已注册工作区"
                  value={selectedWorkspaceId}
                  onChange={e => {
                    const nextId = e.target.value;
                    setSelectedWorkspaceId(nextId);
                    if (nextId !== '__custom__') setNewCwd('');
                  }}
                >
                  {workspaces.map(w => (
                    <option key={w.workspaceId} value={w.workspaceId}>
                      {w.title ? `${w.title} (${w.path})` : w.path}
                    </option>
                  ))}
                  <option value="__custom__">自定义目录路径 (cwd)…</option>
                </select>
              )}
              {(workspaces.length === 0 || selectedWorkspaceId === '__custom__') && (
                <input
                  className="lt-input"
                  placeholder={workspaces[0]?.path || '可选：工作区绝对路径'}
                  value={newCwd}
                  onChange={e => setNewCwd(e.target.value)}
                />
              )}
              {dualModeEnabled && (
                <select
                  className="lt-select"
                  aria-label="新建会话初始执行模式"
                  value={initialMode}
                  onChange={e => setInitialMode(e.target.value === 'single' ? 'single' : 'team')}
                  disabled={busy}
                >
                  <option value="team">Team 团队协作 (默认)</option>
                  <option value="single">Single 单代理直执</option>
                </select>
              )}
              <button className="lt-btn lt-btn-primary" disabled={busy} onClick={() => void handleCreateSession()}>
                + 新建 LeaderTeam 会话
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--lt-fg-muted)', paddingBottom: 8, borderBottom: '1px solid var(--lt-border-subtle)' }}>
              {dualModeEnabled
                ? <>当前为独立伴侣模式（只读浏览历史会话账本并可在空闲时管理 LT 会话执行模式；在 DSH Web 中打开 <code>/lt/</code> 可直接实时对话与发令）。</>
                : <>当前为独立伴侣模式（只读浏览历史会话账本；在 DSH Web 中打开 <code>/lt/</code> 可直接实时对话与发令）。</>}
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
                const rowIsLt = s.isLtSession !== false && s.modeState?.isLtSession !== false;
                const rowMode: ExecutionMode = (s.modeState?.mode ?? s.executionMode) === 'single' ? 'single' : 'team';
                const badgeAttr = !rowIsLt ? 'dsh-native' : rowMode;
                const badgeText = !rowIsLt ? 'DSH 原生' : rowMode === 'single' ? 'Single' : 'Team';
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 11, color: 'var(--lt-fg-muted)', gap: 6 }}>
                      <span className="lt-mono">{s.sessionId.slice(0, 12)}</span>
                      {dualModeEnabled ? (
                        <span className="lt-mode-badge" data-mode={badgeAttr}>{badgeText}</span>
                      ) : (
                        s.isTeam ? <span className="lt-tag">Team</span> : null
                      )}
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
            <div style={{ paddingBottom: 10, borderBottom: '1px solid var(--lt-border-subtle)' }}>
              <div className="lt-card-title" style={{ marginBottom: dualModeEnabled && selectedSessionId ? 6 : 0, flexWrap: 'wrap' }}>
                <div>
                  <span>对话与工程流</span>
                  {selectedSessionId && (
                    <span className="lt-mono" style={{ marginLeft: 10, fontSize: 11.5, color: 'var(--lt-fg-muted)', fontWeight: 400 }}>
                      {selectedSessionId}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {dualModeEnabled && selectedSessionId && renderModeSegmentedControl('顶栏会话执行模式切换')}
                  {bundle.capabilities.frontendSwitch.available && bundle.capabilities.frontendSwitch.dshFrontendUrl && (
                    <a className="lt-btn lt-btn-sm" href={bundle.capabilities.frontendSwitch.dshFrontendUrl}>
                      在 DSH 原生前端查看同一会话 ↗
                    </a>
                  )}
                  {liveHost && selectedSessionId && (
                    <button
                      className="lt-btn lt-btn-sm lt-btn-danger"
                      disabled={busy || !passiveRunning}
                      title={passiveRunning ? '中断当前正在执行的推理回合' : '当前会话处于空闲状态，无运行中回合'}
                      onClick={() => void handleCancelTurn()}
                    >
                      中断当前回合
                    </button>
                  )}
                </div>
              </div>

              {dualModeEnabled && selectedSessionId && (
                <div className="lt-mode-bar">
                  <span style={{ color: isLtSession ? 'var(--lt-fg-secondary)' : 'var(--lt-fg-muted)' }}>
                    {isLtSession
                      ? MODE_BEHAVIOR_HINT[currentMode]
                      : '当前为 DSH 原生预设会话（Single/Team 仅作用于 LT 会话）'}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: !isLtSession
                        ? 'var(--lt-fg-muted)'
                        : switchLockReason
                          ? 'var(--lt-warning)'
                          : 'var(--lt-success)',
                    }}
                  >
                    {switchingMode
                      ? '正在热切换模式…'
                      : switchLockReason
                        ? `🔒 ${switchLockReason}`
                        : '● 空闲可切换（0 次模型调用）'}
                  </span>
                </div>
              )}
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
                  ? dualModeEnabled && currentMode === 'single' && isLtSession
                    ? '输入单代理直执指令（主代理直接读写/命令并受 FinalGate 安全门保护，支持「允许读取 <路径>」）…'
                    : '输入工程任务、评审意见或实时控制指令（支持「最大并发 N」、「允许读取 <路径>」）…'
                  : '独立伴侣模式下仅支持只读观察；通过 dsh web 打开 /lt/ 可直接发送实时指令'
              }
              disabled={!liveHost || !selectedSessionId || busy}
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {dualModeEnabled && selectedSessionId && renderModeSegmentedControl('输入栏会话执行模式切换')}
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
                {sending ? '提交中…' : '发送指令'}
              </button>
            </div>
            {dualModeEnabled && selectedSessionId && switchLockReason && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: isLtSession ? 'var(--lt-warning)' : 'var(--lt-fg-muted)' }}>
                {switchLockReason}
              </div>
            )}
          </form>
        </section>

        {/* RIGHT COLUMN: Real-Time Team & Rolling Frontier HUD */}
        <aside className="lt-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="lt-card-title">
            <span>团队实时态势</span>
            <button className="lt-btn lt-btn-sm" onClick={() => onNavigateTab('governance')}>详情 →</button>
          </div>

          {!activeTeam ? (
            !isLtSession ? (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--lt-radius-sm)',
                  background: 'var(--lt-bg-subtle)',
                  border: '1px solid var(--lt-border-subtle)',
                  color: 'var(--lt-fg-secondary)',
                  fontSize: 12.5,
                  lineHeight: 1.6,
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--lt-fg-primary)', marginBottom: 4 }}>
                  DSH 原生预设会话{selectedSession?.agentPreset ? ` (${selectedSession.agentPreset})` : ''}
                </div>
                <div>
                  当前会话由 DSH 原生预设驱动，不启用 LeaderTeam 团队编排、子代理派发或 Single/Team 模式切换。如需使用 LeaderTeam 能力，请在左侧新建 LeaderTeam 会话。
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--lt-fg-muted)', fontSize: 12.5 }}>
                {dualModeEnabled && currentMode === 'single'
                  ? '当前会话处于 Single 单代理直执模式：主代理在 FinalGate 安全门边界内直接读写文件与执行命令，不创建团队计划、子代理成员或双评审流水线（零团队开销）。空闲时可随时切回 Team 模式启动多代理协作。'
                  : '当前暂无活跃 LeaderTeam 团队目录。在 Team 模式下启动复杂工程任务后，此处将实时展示滚动规划轴线、成员写域与治理状态。'}
              </div>
            )
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
