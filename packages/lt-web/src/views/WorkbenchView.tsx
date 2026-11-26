import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  LtApiError,
  callLtApi,
  fetchWorkbenchSessionConfig,
  fetchWorkbenchSessionMode,
  formatClockTime,
  formatDurationMs,
  formatNumber,
  formatRelativeGroup,
  formatSessionUpdatedLabel,
  switchWorkbenchSessionMode,
  type HydratedBundle,
  type SessionScopedConfigSnapshot,
} from '../lib/api';
import { HeluoxuHorizonMark, HeluoxuMark } from '../components/HeluoxuMark';
import { Icon, type IconName } from '../components/Icon';
import { Splitter } from '../components/AppShell';
import { SessionConfigModal } from '../components/SessionConfigModal';
import { UnknownValue } from '../components/UnknownValue';
import type { ExecutionMode, SessionModeSnapshot, TeamObservation } from '../types/lt-public-v1';

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

interface ReadableToolCall {
  id: string;
  name: string;
  target?: string;
  durationMs?: number | null;
  gate?: 'pass' | 'block' | null;
  status?: 'ok' | 'running' | 'error';
  detail?: string;
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
  toolCalls: ReadableToolCall[];
}

interface LocalEpochEvent {
  id: string;
  afterMessageCount: number;
  icon: IconName;
  label: string;
  modeBadge?: ExecutionMode;
  timeText: string;
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
    Number.isInteger(prev.switchCount) &&
    Number.isInteger(next.switchCount) &&
    next.switchCount < prev.switchCount
  ) {
    return true;
  }
  return false;
}

function iconForToolName(name: string): IconName {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('view') || n.includes('cat')) return 'file';
  if (n.includes('grep') || n.includes('search') || n.includes('find')) return 'search';
  if (n.includes('edit') || n.includes('write') || n.includes('patch')) return 'edit';
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('pwsh')) return 'terminal';
  if (n.includes('dispatch') || n.includes('spawn') || n.includes('team')) return 'network';
  if (n.includes('wait')) return 'hourglass';
  return 'wrench';
}

function renderTeamSeal(status: TeamObservation['status']) {
  if (status === 'paused') return <span className="seal warning">治理会议</span>;
  if (status === 'waiting_user') return <span className="seal solid">人工升级</span>;
  if (status === 'completed') return <span className="seal success">已完成</span>;
  return <span className="seal info">自主执行</span>;
}

function parseCodeSegments(text: string): Array<{ kind: 'text' | 'code'; lang?: string; content: string }> {
  const parts: Array<{ kind: 'text' | 'code'; lang?: string; content: string }> = [];
  const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: 'text', content: text.slice(lastIndex, m.index) });
    }
    parts.push({ kind: 'code', lang: m[1] || 'text', content: m[2].replace(/\n$/, '') });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: 'text', content: text.slice(lastIndex) });
  }
  return parts.length > 0 ? parts : [{ kind: 'text', content: text }];
}

function buildDshSessionHref(baseUrl: string | null | undefined, sessionId: string): string | null {
  if (!baseUrl) return null;
  if (!sessionId) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}session=${encodeURIComponent(sessionId)}`;
}

export function WorkbenchView({
  bundle,
  onRefreshBundle,
  onNavigateTab,
  initialSessionId,
  ctxOpen = true,
  insOpen = true,
  onToggleCtx,
  onToggleIns,
  onNotify,
  onRunningChange,
  onSessionSelected,
  draftsBySession,
  onDraftChange,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
  onNavigateTab: (tab: string) => void;
  initialSessionId?: string;
  ctxOpen?: boolean;
  insOpen?: boolean;
  onToggleCtx?: () => void;
  onToggleIns?: () => void;
  onNotify?: (message: string, icon?: IconName) => void;
  onRunningChange?: (running: boolean) => void;
  onSessionSelected?: (sessionId: string) => void;
  draftsBySession?: Record<string, string>;
  onDraftChange?: (sessionId: string, text: string) => void;
}) {
  const dualModeEnabled = bundle.capabilities.features.inSessionDualMode === true;

  const [liveHost, setLiveHost] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ workspaceId: string; path: string; title?: string }>>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [sessions, setSessions] = useState<WorkbenchSessionItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(initialSessionId || '');
  const [sessionSearch, setSessionSearch] = useState('');
  const [messages, setMessages] = useState<ReadableMessage[]>([]);
  const [passiveRunning, setPassiveRunning] = useState(false);
  const [modeState, setModeState] = useState<SessionModeSnapshot | null>(null);
  const [switchingSessionIds, setSwitchingSessionIds] = useState<Record<string, boolean>>({});
  const [modeError, setModeError] = useState<string | null>(null);
  const [initialMode, setInitialMode] = useState<ExecutionMode>('team');
  const [newCwd, setNewCwd] = useState('');
  const [promptText, setPromptText] = useState(
    initialSessionId && draftsBySession ? draftsBySession[initialSessionId] || '' : '',
  );
  const [promptMode, setPromptMode] = useState<'queue' | 'steer'>('queue');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [epochsBySession, setEpochsBySession] = useState<Record<string, LocalEpochEvent[]>>({});
  const [showLockDetails, setShowLockDetails] = useState(false);
  const [showNewSessionPanel, setShowNewSessionPanel] = useState(false);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  const [showSessionConfig, setShowSessionConfig] = useState(false);
  const [sessionConfigSnap, setSessionConfigSnap] = useState<SessionScopedConfigSnapshot | null>(null);

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionConfigSnap(null);
      return;
    }
    let cancelled = false;
    fetchWorkbenchSessionConfig(selectedSessionId)
      .then(s => {
        if (!cancelled) setSessionConfigSnap(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, passiveRunning]);

  const selectedSessionIdRef = useRef<string>(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const promptTextRef = useRef<string>(promptText);
  promptTextRef.current = promptText;
  const localDraftsRef = useRef<Record<string, string>>({ ...(draftsBySession || {}) });
  if (draftsBySession) {
    for (const [sidKey, draftVal] of Object.entries(draftsBySession)) {
      if (sidKey !== selectedSessionId) {
        localDraftsRef.current[sidKey] = draftVal;
      }
    }
  }
  const imeComposingRef = useRef<boolean>(false);
  const transcriptReqSeqRef = useRef<number>(0);
  const modeMutationEpochRef = useRef<number>(0);
  const prevSelectedSessionRef = useRef<string>(selectedSessionId);
  const streamScrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef<boolean>(true);
  const prevMessageCountRef = useRef<number>(0);

  const updatePromptText = useCallback(
    (nextOrUpdater: string | ((prev: string) => string)) => {
      const sid = selectedSessionIdRef.current;
      const nextVal =
        typeof nextOrUpdater === 'function' ? nextOrUpdater(promptTextRef.current) : nextOrUpdater;
      promptTextRef.current = nextVal;
      setPromptText(nextVal);
      if (sid) {
        if (nextVal) localDraftsRef.current[sid] = nextVal;
        else delete localDraftsRef.current[sid];
        if (onDraftChange) onDraftChange(sid, nextVal);
      }
    },
    [onDraftChange],
  );

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

      const incomingMsgs = res.messages || [];
      setMessages(incomingMsgs);
      const ps = res.passiveState;
      const isRun = Boolean(
        ps && (ps.running === true || ps.busy === true || ps.turnRunning === true || ps.status === 'running'),
      );
      setPassiveRunning(isRun);
      if (onRunningChange) onRunningChange(isRun);
      if (res.modeState) {
        if (modeEpochMatches) {
          applyModeSnapshot(res.modeState);
        }
      } else if (dualModeEnabled && modeEpochMatches) {
        try {
          const fallbackEpoch = modeMutationEpochRef.current;
          const modeRes = await fetchWorkbenchSessionMode(sid);
          if (
            modeRes.modeState &&
            fallbackEpoch === modeMutationEpochRef.current &&
            modeEpoch === modeMutationEpochRef.current
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
        if (onRunningChange) onRunningChange(false);
      }
    }
  }, [dualModeEnabled, syncModeSnapshotIntoSessionList, applyModeSnapshot, onRunningChange]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (initialSessionId && initialSessionId !== selectedSessionIdRef.current) {
      selectedSessionIdRef.current = initialSessionId;
      setSelectedSessionId(initialSessionId);
    }
  }, [initialSessionId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
    setModeError(null);
    setShowLockDetails(false);
    if (onSessionSelected && selectedSessionId) onSessionSelected(selectedSessionId);
    const matched = sessions.find(s => s.sessionId === selectedSessionId);
    if (prevSelectedSessionRef.current !== selectedSessionId) {
      prevSelectedSessionRef.current = selectedSessionId;
      prevMessageCountRef.current = 0;
      pinnedToBottomRef.current = true;
      setHasUnreadBelow(false);
      setMessages([]);
      setPassiveRunning(Boolean(matched?.modeState?.activeTurn));
      setModeState(matched?.modeState ?? null);
      const savedDraft = selectedSessionId
        ? (draftsBySession?.[selectedSessionId] ?? localDraftsRef.current[selectedSessionId] ?? '')
        : '';
      setPromptText(savedDraft);
    } else if (matched?.modeState) {
      applyModeSnapshot(matched.modeState);
    }
    void loadTranscript(selectedSessionId);
    if (!selectedSessionId) return;
    const timer = setInterval(() => {
      void loadTranscript(selectedSessionId);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedSessionId, loadTranscript, applyModeSnapshot, onSessionSelected]);

  useEffect(() => {
    const el = streamScrollRef.current;
    if (!el) return;
    const grew = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasUnreadBelow(false);
    } else if (grew) {
      setHasUnreadBelow(true);
    }
  }, [messages.length, selectedSessionId]);

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
      ? matchedSessionTeam || (!selectedSessionId ? bundle.runtime.teams[0] || null : null)
      : null;

  async function handleSwitchMode(targetMode: ExecutionMode) {
    const targetSid = selectedSessionIdRef.current || selectedSessionId;
    if (!dualModeEnabled || !targetSid || !isLtSession || isSwitchLockedByBusy || targetMode === currentMode) {
      if (isSwitchLockedByBusy && isLtSession) setShowLockDetails(true);
      return;
    }
    const prevMode = currentMode;
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
        const nowStr = formatClockTime(Date.now()) || '刚刚';
        setEpochsBySession(prev => ({
          ...prev,
          [targetSid]: [
            ...(prev[targetSid] || []),
            {
              id: `ep-${Date.now()}`,
              afterMessageCount: messages.length,
              icon: 'swap',
              label: `${prevMode === 'team' ? 'Team' : 'Single'} →`,
              modeBadge: res.modeState.mode,
              timeText: `${nowStr} · 第 ${res.modeState.switchCount} 次切换 · 0 次模型调用`,
            },
          ],
        }));
        const msg = `已切换会话执行模式为 ${res.modeState.mode === 'single' ? 'Single 单代理直执' : 'Team 团队协作'}（0 次模型调用）`;
        setFeedback(msg);
        if (onNotify) onNotify(msg, 'check');
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

  async function handleCreateSession(overrideMode?: ExecutionMode) {
    const modeToUse = overrideMode || initialMode;
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
      const locationSpec =
        matchedWs && (!trimmedCwd || matchedWs.path === trimmedCwd) && selectedWorkspaceId !== '__custom__'
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
        ...(dualModeEnabled ? { executionMode: modeToUse } : {}),
      });
      ++modeMutationEpochRef.current;
      ++transcriptReqSeqRef.current;
      if (created.modeState) {
        setModeState(created.modeState);
        syncModeSnapshotIntoSessionList(created.modeState);
      }
      selectedSessionIdRef.current = created.sessionId;
      setShowNewSessionPanel(false);
      await loadSessions();
      setSelectedSessionId(created.sessionId);
      const createdMode = created.modeState?.mode ?? created.executionMode ?? modeToUse;
      const msg = dualModeEnabled
        ? `已创建新 LeaderTeam 会话：${created.sessionId}（初始模式：${createdMode === 'single' ? 'Single 单代理直执' : 'Team 团队协作'}）`
        : `已创建新 LeaderTeam 会话：${created.sessionId}`;
      setFeedback(msg);
      if (onNotify) onNotify(msg, 'check');
    } catch (e: any) {
      ++modeMutationEpochRef.current;
      ++transcriptReqSeqRef.current;
      setFeedback(`创建会话失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendPrompt(e?: React.FormEvent) {
    if (e) e.preventDefault();
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
      updatePromptText('');
      pinnedToBottomRef.current = true;
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
      const msg = '已向当前会话发送中断请求（保留待处理队列）';
      setFeedback(msg);
      if (onNotify) onNotify(msg, 'stop');
      setEpochsBySession(prev => ({
        ...prev,
        [selectedSessionId]: [
          ...(prev[selectedSessionId] || []),
          {
            id: `ep-cancel-${Date.now()}`,
            afterMessageCount: messages.length,
            icon: 'stop',
            label: '已请求中断当前回合',
            timeText: formatClockTime(Date.now()) || '刚刚',
          },
        ],
      }));
      await loadTranscript(selectedSessionId);
    } catch (err: any) {
      setFeedback(`中断失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function copyText(text: string, label: string) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(text);
      }
      if (onNotify) onNotify(`已复制${label}`, 'check');
    } catch {}
  }

  function renderModeSegmentedControl(ariaLabel: string) {
    const disabledAll = !selectedSessionId || !isLtSession || isSwitchLockedByBusy;
    return (
      <div
        className="lt-mode-segment"
        data-locked={isSwitchLockedByBusy && isLtSession ? 'true' : undefined}
        role="group"
        aria-label={ariaLabel}
        title={switchLockReason || '会话空闲时可零模型调用热切换 Single / Team 执行模式'}
      >
        <button
          type="button"
          className="lt-mode-segment-btn"
          aria-pressed={isLtSession && currentMode === 'team'}
          disabled={disabledAll}
          title="Team 团队协作"
          onClick={() => void handleSwitchMode('team')}
        >
          <Icon name="network" className="icon-14" />
          Team
        </button>
        <button
          type="button"
          className="lt-mode-segment-btn"
          aria-pressed={isLtSession && currentMode === 'single'}
          disabled={disabledAll}
          title="Single 单代理直执"
          onClick={() => void handleSwitchMode('single')}
        >
          <Icon name="user" className="icon-14" />
          Single
        </button>
      </div>
    );
  }

  const filteredSessions = sessions.filter(s => {
    const q = sessionSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      s.sessionId.toLowerCase().includes(q) ||
      (s.title || '').toLowerCase().includes(q) ||
      (s.cwd || '').toLowerCase().includes(q)
    );
  });

  const groupedSessions: Array<{ group: '今天' | '昨天' | '更早'; items: WorkbenchSessionItem[] }> = [];
  const groupBuckets: Record<'今天' | '昨天' | '更早', WorkbenchSessionItem[]> = {
    今天: [],
    昨天: [],
    更早: [],
  };
  for (const s of filteredSessions) {
    groupBuckets[formatRelativeGroup(s.updatedAt)].push(s);
  }
  for (const g of ['今天', '昨天', '更早'] as const) {
    if (groupBuckets[g].length > 0) {
      groupedSessions.push({ group: g, items: groupBuckets[g] });
    }
  }

  const activeWorkspace =
    workspaces.find(w => w.workspaceId === selectedWorkspaceId) || workspaces[0] || null;
  const dshSessionHref = bundle.capabilities.frontendSwitch.available
    ? buildDshSessionHref(bundle.capabilities.frontendSwitch.dshFrontendUrl, selectedSessionId)
    : null;
  const leaderRoute = bundle.runtime.roleAssignments.leader;
  const localEpochs = selectedSessionId ? epochsBySession[selectedSessionId] || [] : [];

  return (
    <div className="body" style={{ flex: 1 }}>
      {/* ==================== LEFT CONTEXT PANE: Workspaces & Sessions ==================== */}
      <aside
        className={`pane pane-context${ctxOpen ? '' : ' is-floating-hidden'}`}
        hidden={!ctxOpen}
        aria-label="工作区与会话列表"
      >
        <div className="pane-head" style={{ gap: 6 }}>
          <Icon name="folder" />
          <span className="ellipsis grow" style={{ fontWeight: 600, fontSize: 'var(--lt-fs-dense)' }}>
            {activeWorkspace?.title || (activeWorkspace?.path ? activeWorkspace.path.split('/').pop() : '工作台会话')}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void loadSessions()}
            title="刷新会话列表"
          >
            刷新
          </button>
          {bundle.capabilities.features.liveSessionRpc && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => setShowNewSessionPanel(v => !v)}
              title="新建 LeaderTeam 会话"
            >
              <Icon name="plus" className="icon-14" />
              新建
            </button>
          )}
        </div>

        {bundle.capabilities.features.liveSessionRpc && showNewSessionPanel && (
          <div className="pane-section" style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--lt-bg-surface)' }}>
            {workspaces.length > 0 && (
              <select
                className="select select-sm"
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
                className="input input-sm mono"
                placeholder={workspaces[0]?.path || '可选：工作区绝对路径'}
                value={newCwd}
                onChange={e => setNewCwd(e.target.value)}
              />
            )}
            {dualModeEnabled && (
              <select
                className="select select-sm"
                aria-label="新建会话初始执行模式"
                value={initialMode}
                onChange={e => setInitialMode(e.target.value === 'single' ? 'single' : 'team')}
                disabled={busy}
              >
                <option value="team">Team 团队协作 (默认)</option>
                <option value="single">Single 单代理直执</option>
              </select>
            )}
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary grow"
                disabled={busy}
                onClick={() => void handleCreateSession()}
              >
                <Icon name="plus" className="icon-14" />
                创建会话
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowNewSessionPanel(false)}
              >
                收起
              </button>
            </div>
          </div>
        )}

        <div style={{ padding: '10px 12px 4px' }}>
          <label className="search">
            <Icon name="search" />
            <input
              className="input input-sm"
              placeholder="搜索会话、ID…"
              aria-label="搜索会话"
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
            />
          </label>
        </div>

        <div className="pane-body">
          {filteredSessions.length === 0 ? (
            <div className="empty" style={{ padding: '28px 14px' }}>
              <span className="t-small">
                {sessions.length === 0 ? '尚无会话记录。点击上方「新建」创建会话，或先在「接入」配置模型。' : '无匹配会话'}
              </span>
            </div>
          ) : (
            groupedSessions.map(({ group, items }) => (
              <div key={group}>
                <div className="list-group-label t-overline">{group}</div>
                <div className="list">
                  {items.map(s => {
                    const selected = s.sessionId === selectedSessionId;
                    const rowIsLt = s.isLtSession !== false && s.modeState?.isLtSession !== false;
                    const rowMode: ExecutionMode =
                      (s.modeState?.mode ?? s.executionMode) === 'single' ? 'single' : 'team';
                    const badgeAttr = !rowIsLt ? 'dsh-native' : rowMode;
                    const badgeText = !rowIsLt ? 'DSH 原生' : rowMode === 'single' ? 'Single' : 'Team';
                    const rowRunning = Boolean(
                      (selected && passiveRunning) || s.modeState?.activeTurn,
                    );
                    return (
                      <button
                        key={s.sessionId}
                        type="button"
                        className="list-item"
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => setSelectedSessionId(s.sessionId)}
                      >
                        <span className="col grow" style={{ gap: 4 }}>
                          <span className="row">
                            <span
                              className="ellipsis"
                              style={{ fontWeight: selected ? 600 : 500, fontSize: 'var(--lt-fs-dense)' }}
                            >
                              {s.title || s.sessionId.slice(0, 18)}
                            </span>
                          </span>
                          <span className="row" style={{ gap: 6 }}>
                            {dualModeEnabled ? (
                              <span className="lt-mode-badge" data-mode={badgeAttr}>
                                {badgeText}
                              </span>
                            ) : s.isTeam ? (
                              <span className="badge sm info">Team</span>
                            ) : null}
                            <span className="mono muted" style={{ fontSize: 10.5 }}>
                              {s.sessionId.slice(0, 12)}
                            </span>
                            <span className="grow" />
                            {rowRunning ? (
                              <span className="row" style={{ gap: 5, fontSize: 11, color: 'var(--lt-info)' }}>
                                <i className="dot run breath" />
                                运行中
                              </span>
                            ) : (
                              <span className="muted num" style={{ fontSize: 11 }}>
                                {formatSessionUpdatedLabel(s.updatedAt)}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="pane-section hairline-top" style={{ padding: '10px 14px', fontSize: 11.5, color: 'var(--lt-fg-muted)' }}>
          <div className="mono ellipsis" title={selectedSession?.cwd || activeWorkspace?.path || ''}>
            {selectedSession?.cwd || activeWorkspace?.path || (bundle.capabilities.features.liveSessionRpc ? 'DSH 工作区已连接' : '独立伴侣只读账本')}
          </div>
        </div>
      </aside>

      <Splitter which="ctx" hidden={!ctxOpen} />

      {/* ==================== CENTER STAGE: Stream & Composer ==================== */}
      <main className="stage">
        <div className="stage-head" style={{ gap: 10 }}>
          {!ctxOpen && onToggleCtx && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              onClick={onToggleCtx}
              title="展开会话栏（Ctrl+B）"
            >
              <Icon name="panelL" />
            </button>
          )}
          <div className="col" style={{ gap: 1, flex: '1 1 0%', minWidth: 0, overflow: 'hidden' }}>
            <h1 className="ellipsis" style={{ margin: 0, fontSize: 14.5, fontWeight: 600, lineHeight: 1.3 }}>
              {selectedSession?.title || (selectedSessionId ? '工程会话' : 'Leader Team 工作台')}
            </h1>
            <div className="row t-meta" style={{ gap: 6, flexWrap: 'nowrap', overflow: 'hidden' }}>
              {selectedSessionId && (
                <span className="mono" style={{ flexShrink: 0 }}>
                  {selectedSessionId}
                </span>
              )}
              {selectedSession?.cwd && (
                <>
                  <span style={{ flexShrink: 0 }}>·</span>
                  <span className="mono ellipsis">{selectedSession.cwd}</span>
                </>
              )}
              {activeTeam && (
                <>
                  <span style={{ flexShrink: 0 }}>·</span>
                  <span className="mono" style={{ flexShrink: 0 }}>
                    {activeTeam.teamId.slice(0, 12)} #{activeTeam.taskSeq}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="row" style={{ gap: 6, flexShrink: 0, position: 'relative' }}>
            {dualModeEnabled && selectedSessionId && (
              isLtSession ? (
                <>
                  {renderModeSegmentedControl('顶栏会话执行模式切换')}
                  {isSwitchLockedByBusy ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--lt-warning)', padding: '0 6px' }}
                      onClick={() => setShowLockDetails(v => !v)}
                    >
                      <Icon name="lock" className="icon-14" />
                      运行中锁定
                    </button>
                  ) : (
                    <span className="t-meta" style={{ whiteSpace: 'nowrap' }} title="切换仅改变下一回合的执行策略，0 次模型调用">
                      空闲可切换
                    </span>
                  )}
                </>
              ) : (
                <span className="badge outline" title="DSH 原生预设会话不使用 LT 执行模式">
                  DSH 原生
                </span>
              )
            )}

            {selectedSessionId && isLtSession && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowSessionConfig(true)}
                title="仅修改当前会话的模型、角色与并发配置（不影响全局与其他会话）"
              >
                <Icon name="sliders" className="icon-14" />
                <span>
                  {sessionConfigSnap?.hasPending
                    ? '本会话待切换'
                    : sessionConfigSnap?.hasOverride
                      ? `本会话专属 · ${sessionConfigSnap.effective.roles?.leader?.route?.split('/').pop() || '已定制'}`
                      : '本会话模型配置'}
                </span>
              </button>
            )}

            {showLockDetails && isLtSession && isSwitchLockedByBusy && (
              <div
                className="pop"
                style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 310, zIndex: 80 }}
              >
                <div style={{ padding: '6px 8px 4px' }}>
                  <div className="row-between" style={{ marginBottom: 6 }}>
                    <span className="row" style={{ gap: 6, fontWeight: 600, color: 'var(--lt-warning)' }}>
                      <Icon name="lock" className="icon-14" />
                      模式切换已锁定
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => setShowLockDetails(false)}
                      aria-label="关闭锁定详情"
                    >
                      <Icon name="x" className="icon-14" />
                    </button>
                  </div>
                  <p className="t-small secondary" style={{ margin: '0 0 8px' }}>
                    {switchLockReason}
                  </p>
                  {[
                    ['当前回合执行中', Boolean(passiveRunning || effectiveModeState?.activeTurn) ? '是' : '否', Boolean(passiveRunning || effectiveModeState?.activeTurn)],
                    ['活跃成员', `${effectiveModeState?.activeMembersCount ?? 0} 名`, (effectiveModeState?.activeMembersCount ?? 0) > 0],
                    ['待结评审', `${effectiveModeState?.pendingReviewsCount ?? 0} 项`, (effectiveModeState?.pendingReviewsCount ?? 0) > 0],
                    ['治理会议 / 人工升级', effectiveModeState?.activeConferenceId ? '进行中' : '无', Boolean(effectiveModeState?.activeConferenceId)],
                  ].map(([lbl, val, on]) => (
                    <div key={String(lbl)} className="row-between t-small" style={{ padding: '3px 0' }}>
                      <span className="row" style={{ gap: 6 }}>
                        <i className={`dot ${on ? 'warn' : 'idle'}`} />
                        {lbl}
                      </span>
                      <span className="num muted">{val}</span>
                    </div>
                  ))}
                  <div className="menu-sep" />
                  <div className="t-meta">切换仅在空闲时可用，且 0 次模型调用。等待回合结束或中断后再切换。</div>
                </div>
              </div>
            )}

            {dshSessionHref && (
              <>
                <span style={{ width: 1, height: 18, background: 'var(--lt-border-subtle)' }} />
                <a
                  className="btn btn-sm"
                  href={dshSessionHref}
                  title="携带当前 sessionId 在 DSH 原生前端打开；运行中的团队不中断"
                >
                  <Icon name="swap" className="icon-14" />
                  在 DSH 中打开
                </a>
              </>
            )}

            {onToggleIns && (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                onClick={onToggleIns}
                title={insOpen ? '收起检视栏（Ctrl+.）' : '展开检视栏（Ctrl+.）'}
              >
                <Icon name="panelR" />
              </button>
            )}
          </div>
        </div>

        {/* Slim telemetry mode-bar (hidden on 1.0.0 backends without inSessionDualMode) */}
        {dualModeEnabled && selectedSessionId && (
          <div className="lt-mode-bar">
            <span style={{ color: isLtSession ? 'var(--lt-fg-secondary)' : 'var(--lt-fg-muted)' }}>
              {isLtSession
                ? MODE_BEHAVIOR_HINT[currentMode]
                : '当前为 DSH 原生预设会话（Single/Team 仅作用于 LT 会话）'}
            </span>
            <span
              style={{
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
                  ? switchLockReason
                  : '空闲可切换（0 次模型调用）'}
            </span>
          </div>
        )}

        {/* Inline session-scoped notices & error alerts */}
        {(feedback || modeError) && (
          <div style={{ padding: '8px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {modeError && (
              <div className="callout danger" role="alert">
                <Icon name="alert" />
                <span className="grow">{modeError}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModeError(null)}>
                  关闭
                </button>
              </div>
            )}
            {feedback && (
              <div className="callout info">
                <Icon name="info" />
                <span className="grow">{feedback}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFeedback(null)}>
                  关闭
                </button>
              </div>
            )}
          </div>
        )}

        {/* Conversation reading stream */}
        <div
          ref={streamScrollRef}
          className="stage-body"
          onScroll={e => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            pinnedToBottomRef.current = atBottom;
            if (atBottom) setHasUnreadBelow(false);
          }}
        >
          <div className="stream">
            <div className="stream-col">
              {messages.length === 0 ? (
                <div className="empty" style={{ padding: '64px 24px' }}>
                  <HeluoxuHorizonMark />
                  <h3>{selectedSessionId ? '当前会话尚无消息回执' : '选择或新建一条工程会话'}</h3>
                  <p className="t-small" style={{ maxWidth: 460, margin: 0 }}>
                    支持自然语言工程任务与内联控制指令（如 <code>最大并发 4</code>、<code>允许读取 /path</code>）；空闲时可在 Team 与 Single 间零模型调用切换。
                  </p>
                </div>
              ) : (
                messages.map((m, idx) => {
                  const segs = parseCodeSegments(m.text || '');
                  const epochsAfter = localEpochs.filter(ep => ep.afterMessageCount === idx + 1);
                  return (
                    <React.Fragment key={m.id}>
                      <article className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-agent'}`}>
                        <div className="msg-head">
                          <span className="msg-avatar">
                            {m.role === 'user' ? (
                              <Icon name="user" className="icon-14" />
                            ) : (
                              <HeluoxuMark size={14} />
                            )}
                          </span>
                          <span className="who">
                            {m.role === 'user'
                              ? '你'
                              : !isLtSession
                                ? 'DSH 主代理'
                                : currentMode === 'team'
                                  ? '领队'
                                  : '主代理'}
                          </span>
                          {m.role === 'assistant' && dualModeEnabled && isLtSession && (
                            <span className={`mode-badge ${currentMode}`}>
                              <Icon name={currentMode === 'team' ? 'network' : 'user'} className="icon-14" />
                              {currentMode === 'team' ? 'Team' : 'Single'}
                            </span>
                          )}
                          {m.timeMs ? <span className="num">{formatClockTime(m.timeMs)}</span> : null}
                          <span className="msg-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon btn-sm"
                              title="复制消息内容"
                              onClick={() => copyText(m.text || '', '消息内容')}
                            >
                              <Icon name="copy" className="icon-14" />
                            </button>
                          </span>
                        </div>

                        {m.thinkingPreview && (
                          <details className="thinking">
                            <summary>
                              <Icon name="chevR" className="chev icon-14" />
                              推理摘要 (Thinking)
                            </summary>
                            <div className="thinking-body">{m.thinkingPreview}</div>
                          </details>
                        )}

                        {m.text && (
                          <div className="msg-body">
                            {segs.map((seg, si) =>
                              seg.kind === 'code' ? (
                                <div key={si} className="codeblock">
                                  <div className="codeblock-head">
                                    <span>{seg.lang}</span>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      onClick={() => copyText(seg.content, '代码块')}
                                    >
                                      <Icon name="copy" className="icon-14" />
                                      复制
                                    </button>
                                  </div>
                                  <pre>{seg.content}</pre>
                                </div>
                              ) : (
                                <div key={si}>{seg.content}</div>
                              ),
                            )}
                          </div>
                        )}

                        {m.toolCalls && m.toolCalls.length > 0 && (
                          <div className="tools">
                            {m.toolCalls.length >= 3 && (
                              <div className="tools-summary">
                                <Icon name="wrench" className="icon-14" />
                                <span>{m.toolCalls.length} 次工具调用</span>
                              </div>
                            )}
                            {m.toolCalls.map(tc => {
                              const toolKey = `${m.id}:${tc.id}`;
                              const isOpen = Boolean(openTools[toolKey]);
                              return (
                                <div
                                  key={tc.id}
                                  className={`tool${tc.status === 'running' ? ' is-running' : tc.status === 'error' ? ' is-error' : ''}`}
                                  data-open={isOpen ? 'true' : 'false'}
                                >
                                  <button
                                    type="button"
                                    className="tool-row"
                                    aria-expanded={isOpen}
                                    onClick={() =>
                                      setOpenTools(prev => ({ ...prev, [toolKey]: !prev[toolKey] }))
                                    }
                                  >
                                    <span className="tool-ico">
                                      {tc.status === 'running' ? (
                                        <i className="dot run breath" style={{ marginLeft: 4 }} />
                                      ) : (
                                        <Icon name={iconForToolName(tc.name)} />
                                      )}
                                    </span>
                                    <span className="tool-name">{tc.name}</span>
                                    <span className="tool-target">{tc.target || tc.id}</span>
                                    {tc.gate === 'pass' ? (
                                      <span className="badge sm success" title="安全门已放行">
                                        <Icon name="shield" />
                                        放行
                                      </span>
                                    ) : tc.gate === 'block' ? (
                                      <span className="badge sm danger" title="安全门已拦截">
                                        <Icon name="shield" />
                                        拦截
                                      </span>
                                    ) : (
                                      <span />
                                    )}
                                    <span className="tool-dur">
                                      {tc.status === 'running'
                                        ? '进行中'
                                        : tc.durationMs != null
                                          ? formatDurationMs(tc.durationMs)
                                          : ''}
                                    </span>
                                    <Icon name="chevR" className="chev icon-14" />
                                  </button>
                                  <div className="tool-detail">
                                    <div className="muted">
                                      工具：<span className="mono">{tc.name}</span> · ID：
                                      <span className="mono">{tc.id}</span>
                                    </div>
                                    {tc.detail && <pre>{tc.detail}</pre>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {(m.model || m.usage?.totalTokens != null) && (
                          <div className="msg-meta">
                            {m.model && <span className="tag">{m.model}</span>}
                            {m.usage?.totalTokens != null && (
                              <span className="num">{formatNumber(m.usage.totalTokens)} tok</span>
                            )}
                            {m.usage?.cacheReadTokens ? (
                              <span className="num">缓存读 {formatNumber(m.usage.cacheReadTokens)}</span>
                            ) : null}
                          </div>
                        )}
                      </article>

                      {epochsAfter.map(ep => (
                        <div key={ep.id} className="epoch" role="separator">
                          <span className="epoch-label">
                            <Icon name={ep.icon} className="icon-14" />
                            <span>{ep.label}</span>
                            {ep.modeBadge && (
                              <span className={`mode-badge ${ep.modeBadge}`}>
                                <Icon name={ep.modeBadge === 'team' ? 'network' : 'user'} className="icon-14" />
                                {ep.modeBadge === 'team' ? 'Team' : 'Single'}
                              </span>
                            )}
                            <span>· {ep.timeText}</span>
                          </span>
                        </div>
                      ))}
                    </React.Fragment>
                  );
                })
              )}

              {localEpochs
                .filter(ep => ep.afterMessageCount === 0 || ep.afterMessageCount > messages.length)
                .map(ep => (
                  <div key={ep.id} className="epoch" role="separator">
                    <span className="epoch-label">
                      <Icon name={ep.icon} className="icon-14" />
                      <span>{ep.label}</span>
                      {ep.modeBadge && (
                        <span className={`mode-badge ${ep.modeBadge}`}>
                          {ep.modeBadge === 'team' ? 'Team' : 'Single'}
                        </span>
                      )}
                      <span>· {ep.timeText}</span>
                    </span>
                  </div>
                ))}
            </div>
          </div>

          {hasUnreadBelow && (
            <div style={{ display: 'flex', justifyContent: 'center', position: 'sticky', bottom: 14, pointerEvents: 'none' }}>
              <button
                type="button"
                className="jump-bottom-btn"
                style={{ pointerEvents: 'auto', position: 'static', transform: 'none' }}
                onClick={() => {
                  const el = streamScrollRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                  pinnedToBottomRef.current = true;
                  setHasUnreadBelow(false);
                }}
              >
                <Icon name="arrowDown" className="icon-14" />
                新消息
              </button>
            </div>
          )}
        </div>

        {/* Bottom Composer or Standalone Companion Read-Only Bar */}
        <div className="composer-wrap">
          {!bundle.capabilities.features.liveSessionRpc && !liveHost ? (
            <div className="readonly-bar">
              <Icon name="info" />
              <span className="grow">
                {dualModeEnabled
                  ? '独立伴侣模式：可浏览全部会话历史、在空闲时切换执行模式并管理接入配置。发送指令与新建会话需要 DSH Web 实时宿主。'
                  : '独立伴侣模式：可浏览全部会话历史并管理接入配置。发送指令与新建会话需要 DSH Web 实时宿主。'}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => copyText('dsh web', '启动命令')}
              >
                <Icon name="copy" className="icon-14" />
                复制 <span className="mono">dsh web</span>
              </button>
            </div>
          ) : (
            <form onSubmit={handleSendPrompt}>
              <div className="composer">
                <textarea
                  rows={2}
                  placeholder={
                    passiveRunning
                      ? '回合进行中：选择「排队」在本回合后执行，或「引导」即时修正方向…'
                      : dualModeEnabled && currentMode === 'single' && isLtSession
                        ? '输入单代理直执指令（主代理直接读写/命令并受安全门守护）…'
                        : '描述下一步工程目标（支持「最大并发 N」、「允许读取 <路径>」）…'
                  }
                  disabled={!liveHost || !selectedSessionId || busy}
                  value={promptText}
                  onChange={e => updatePromptText(e.target.value)}
                  onCompositionStart={() => {
                    imeComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    imeComposingRef.current = false;
                  }}
                  onKeyDown={e => {
                    const nativeEv = e.nativeEvent as any;
                    const isComposing =
                      imeComposingRef.current ||
                      Boolean(nativeEv?.isComposing) ||
                      Boolean((e as any).isComposing) ||
                      e.keyCode === 229 ||
                      nativeEv?.keyCode === 229 ||
                      e.key === 'Process';
                    if (isComposing) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendPrompt();
                    }
                  }}
                />
                <div className="composer-bar" style={{ gap: 6 }}>
                  {isLtSession && (
                    <>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: '0 6px' }}
                        disabled={!liveHost || !selectedSessionId}
                        title="插入内联指令：最大并发 3"
                        onClick={() =>
                          updatePromptText(prev => (prev ? `${prev}\n最大并发 3` : '最大并发 3'))
                        }
                      >
                        <Icon name="gauge" className="icon-14" />
                        并发 N
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: '0 6px' }}
                        disabled={!liveHost || !selectedSessionId}
                        title="插入内联指令：允许读取 ./docs"
                        onClick={() =>
                          updatePromptText(prev => (prev ? `${prev}\n允许读取 ./docs` : '允许读取 ./docs'))
                        }
                      >
                        <Icon name="file" className="icon-14" />
                        允许读取
                      </button>
                    </>
                  )}
                  <span className="grow" />
                  <div className="seg seg-sm" role="radiogroup" aria-label="投递方式">
                    <button
                      type="button"
                      aria-pressed={promptMode === 'queue'}
                      disabled={!liveHost}
                      title="回合结束后按序执行"
                      onClick={() => setPromptMode('queue')}
                    >
                      <Icon name="queue" className="icon-14" />
                      排队
                    </button>
                    <button
                      type="button"
                      aria-pressed={promptMode === 'steer'}
                      disabled={!liveHost}
                      title="立即注入当前回合，引导方向"
                      onClick={() => setPromptMode('steer')}
                    >
                      <Icon name="steer" className="icon-14" />
                      引导
                    </button>
                  </div>
                  {liveHost && selectedSessionId && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy || !passiveRunning}
                      title={passiveRunning ? '中断当前正在执行的推理回合' : '当前会话处于空闲状态，无运行中回合'}
                      onClick={() => void handleCancelTurn()}
                    >
                      中断当前回合
                    </button>
                  )}
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={!liveHost || !selectedSessionId || !promptText.trim() || busy}
                  >
                    <Icon name="send" className="icon-14" />
                    {sending ? '提交中…' : '发送'}
                  </button>
                </div>
              </div>
              <div className="composer-foot">
                <span className="row" style={{ gap: 6 }}>
                  <Icon name="route" className="icon-14" />
                  {!isLtSession ? 'DSH 主代理' : currentMode === 'team' ? '领队' : '主代理'} →{' '}
                  <span className="mono">{leaderRoute?.route || '未配置'}</span>
                  {leaderRoute?.effort ? ` · ${leaderRoute.effort}` : ''}
                  {leaderRoute?.fallback?.length ? ` · 备选 ${leaderRoute.fallback.length} 级` : ''}
                </span>
                {dualModeEnabled && currentMode === 'single' && isLtSession && (
                  <span className="row" style={{ gap: 5 }}>
                    <Icon name="shield" className="icon-14" />
                    安全门守护直接读写
                  </span>
                )}
                <span className="grow" />
                <span>
                  <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
                </span>
              </div>
            </form>
          )}
        </div>
      </main>

      <Splitter which="ins" hidden={!insOpen} />

      {/* ==================== RIGHT INSPECTOR: Team HUD / Single / DSH Native ==================== */}
      <aside
        className={`pane pane-inspector${insOpen ? '' : ' is-floating-hidden'}`}
        hidden={!insOpen}
        aria-label="当前会话与团队检视栏"
      >
        {!isLtSession ? (
          <>
            <div className="pane-head">
              <span className="t-subhead" style={{ fontSize: 14 }}>
                会话概览
              </span>
              <span className="grow" />
              <span className="mode-badge dsh">DSH 原生</span>
            </div>
            <div className="pane-body">
              <div className="pane-section">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  DSH 原生预设会话{selectedSession?.agentPreset ? ` (${selectedSession.agentPreset})` : ''}
                </div>
                <p className="t-small secondary" style={{ margin: '0 0 12px', lineHeight: 1.65 }}>
                  当前会话由 DSH 原生预设驱动，不启用 LeaderTeam 团队编排、子代理派发或 Single/Team 模式切换。如需使用 LeaderTeam 能力，请在左侧新建 LeaderTeam 会话。
                </p>
                {dshSessionHref && (
                  <a className="btn btn-sm" href={dshSessionHref}>
                    <Icon name="swap" className="icon-14" />
                    在 DSH 原生前端打开
                  </a>
                )}
              </div>
            </div>
          </>
        ) : dualModeEnabled && currentMode === 'single' ? (
          <>
            <div className="pane-head">
              <span className="t-subhead" style={{ fontSize: 14 }}>
                会话概览
              </span>
              <span className="grow" />
              <span className="seal">直执</span>
            </div>
            <div className="pane-body">
              <div className="pane-section">
                <p className="t-small secondary" style={{ margin: 0, lineHeight: 1.65 }}>
                  当前会话处于 Single 单代理直执模式：主代理在安全门守护下直接读写文件与执行命令，不创建团队计划、子代理成员或双评审流水线（零团队开销）。空闲时可随时切回 Team 模式启动多代理协作。
                </p>
              </div>
              <div className="pane-section">
                <dl className="kv">
                  <dt>主代理路由</dt>
                  <dd className="mono ellipsis">{leaderRoute?.route || '未配置'}</dd>
                  <dt>推理强度</dt>
                  <dd>{leaderRoute?.effort || '—'}</dd>
                  <dt>安全门</dt>
                  <dd>
                    <span className="badge sm success">安全门守护</span>
                  </dd>
                  <dt>模式切换</dt>
                  <dd className="num">{effectiveModeState?.switchCount ?? 0} 次</dd>
                </dl>
              </div>
              <div className="pane-section">
                <div className="pane-section-title">
                  <span className="t-overline">执行纪元</span>
                </div>
                <ol className="axis">
                  <li className="run">
                    <span className="axis-node" />
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mode-badge single">
                        <Icon name="user" className="icon-14" />
                        Single
                      </span>
                      <span className="t-small">当前活跃模式</span>
                    </div>
                    <div className="t-meta" style={{ marginTop: 3 }}>
                      零团队开销 · {messages.length} 条对话消息
                    </div>
                  </li>
                </ol>
              </div>
              {bundle.capabilities.features.usageAnalytics && (
                <div className="pane-section">
                  <div className="pane-section-title">
                    <span className="t-overline">用量对账</span>
                    <button
                      type="button"
                      className="link-btn t-meta"
                      onClick={() => onNavigateTab('hengzhang')}
                    >
                      衡账 →
                    </button>
                  </div>
                  <div className="t-meta">前往衡账查看该会话的真实 Token 桶与峰谷等效成本。</div>
                </div>
              )}
            </div>
          </>
        ) : !activeTeam ? (
          <>
            <div className="pane-head">
              <span className="t-subhead" style={{ fontSize: 14 }}>
                当前团队
              </span>
              <span className="grow" />
              <span className="mode-badge team">Team</span>
            </div>
            <div className="pane-body">
              <div className="pane-section">
                <p className="t-small secondary" style={{ margin: 0, lineHeight: 1.65 }}>
                  当前暂无活跃 LeaderTeam 团队目录。在 Team 模式下启动复杂工程任务后，此处将实时展示滚动规划轴线、成员写域与治理状态。
                </p>
              </div>
              <div className="pane-section">
                <dl className="kv">
                  <dt>领队路由</dt>
                  <dd className="mono ellipsis">{leaderRoute?.route || '未配置'}</dd>
                  <dt>有效并发上限</dt>
                  <dd className="num">
                    {bundle.runtime.scheduler.effectiveCap ?? bundle.runtime.scheduler.maxActiveMembers}
                  </dd>
                  <dt>执行池模型</dt>
                  <dd className="num">{bundle.runtime.modelPool.executionPool.length} 个</dd>
                </dl>
              </div>
              {bundle.capabilities.features.teamObservability && (
                <div className="pane-section">
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%' }}
                    onClick={() => onNavigateTab('teams')}
                  >
                    前往团队与治理视图 <Icon name="chevR" className="icon-14" />
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="pane-head">
              <span className="t-subhead" style={{ fontSize: 14 }}>
                当前团队
              </span>
              <span className="mono t-meta ellipsis">{activeTeam.teamId.slice(0, 12)}</span>
              <span className="grow" />
              {renderTeamSeal(activeTeam.status)}
            </div>
            <div className="pane-body">
              {activeTeam.status === 'waiting_user' && (
                <div className="pane-section">
                  <div className="callout danger">
                    <Icon name="gavel" />
                    <div className="col" style={{ gap: 6 }}>
                      <b>等待人工裁决升级</b>
                      <span className="t-small">评审意见未能收敛或触发升级屏障，请前往团队视图查看详情。</span>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => onNavigateTab('teams')}
                        >
                          前往裁决
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTeam.status === 'paused' && (
                <div className="pane-section">
                  <div className="callout warning">
                    <Icon name="users" />
                    <div className="col" style={{ gap: 4 }}>
                      <b>治理会议进行中</b>
                      <span className="t-small">成员已在安全点暂停，裁断完成后自动恢复。</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="pane-section">
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <span className="hash-seal">
                    {activeTeam.frozenGovernanceHash ? activeTeam.frozenGovernanceHash.slice(0, 10) : '未冻结'}
                  </span>
                  <span className="t-meta">
                    任务{' '}
                    <span className="num" style={{ color: 'var(--lt-fg-primary)', fontWeight: 600 }}>
                      #{activeTeam.taskSeq}
                    </span>
                  </span>
                </div>
                {activeTeam.timers && (
                  <div
                    className="grid grid-2"
                    style={{
                      gap: 1,
                      background: 'var(--lt-border-subtle)',
                      border: '1px solid var(--lt-border-subtle)',
                      borderRadius: 'var(--lt-radius-md)',
                      overflow: 'hidden',
                    }}
                  >
                    {[
                      ['项目跨度', formatDurationMs(activeTeam.timers.projectWallMs)],
                      ['累计活跃', formatDurationMs(activeTeam.timers.projectActiveMs)],
                      ['本轮耗时', formatDurationMs(activeTeam.timers.taskWallMs)],
                      [
                        '时间压力',
                        activeTeam.timers.timePressure === 'critical'
                          ? '高'
                          : activeTeam.timers.timePressure === 'elevated'
                            ? '中'
                            : '低',
                      ],
                    ].map(([lbl, val], i) => (
                      <div key={lbl} style={{ background: 'var(--lt-bg-subtle)', padding: '8px 10px' }}>
                        <div className="t-meta" style={{ fontSize: 11 }}>
                          {lbl}
                        </div>
                        <div
                          className="num"
                          style={{
                            fontWeight: 600,
                            marginTop: 2,
                            color:
                              i === 3
                                ? activeTeam.timers?.timePressure === 'critical'
                                  ? 'var(--lt-danger)'
                                  : activeTeam.timers?.timePressure === 'elevated'
                                    ? 'var(--lt-warning)'
                                    : 'var(--lt-success)'
                                : undefined,
                          }}
                        >
                          {val}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pane-section">
                <div className="pane-section-title">
                  <span className="t-overline">滚动规划</span>
                  <span className="t-meta num">
                    {activeTeam.frontierStages.filter(s => s.executionState === 'verified').length} /{' '}
                    {activeTeam.frontierStages.length}
                  </span>
                </div>
                {activeTeam.frontierStages.length === 0 ? (
                  <div className="t-meta">等待领队发布滚动阶段计划</div>
                ) : (
                  <ol className="axis">
                    {activeTeam.frontierStages.map(st => {
                      const cls =
                        st.executionState === 'verified'
                          ? 'done'
                          : st.executionState === 'running'
                            ? 'run'
                            : st.executionState === 'blocked'
                              ? 'blocked'
                              : '';
                      return (
                        <li key={st.stageId} className={cls}>
                          <span className="axis-node" />
                          <div className="row" style={{ gap: 6 }}>
                            <span className="mono" style={{ fontSize: 11, color: 'var(--lt-fg-muted)' }}>
                              {st.stageId}
                            </span>
                            <span
                              className="t-small ellipsis"
                              style={{ fontWeight: st.executionState === 'running' ? 600 : 400 }}
                            >
                              {st.title}
                            </span>
                          </div>
                          <div className="row" style={{ gap: 6, marginTop: 3 }}>
                            {st.executionState === 'running' && (
                              <span className="badge sm info">执行中</span>
                            )}
                            {st.executionState === 'verified' && (
                              <span className="badge sm success">已验收</span>
                            )}
                            {st.executionState === 'blocked' && (
                              <span className="badge sm warning">阻塞</span>
                            )}
                            {st.executionState === 'ready' && (
                              <span className="badge sm outline">就绪</span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              <div className="pane-section">
                <div className="pane-section-title">
                  <span className="t-overline">成员</span>
                  <span className="t-meta num">
                    {activeTeam.members.filter(mb => mb.status === 'running').length} 活跃 /{' '}
                    {activeTeam.members.length}
                  </span>
                </div>
                {activeTeam.members.length === 0 ? (
                  <div className="t-meta">尚未派发执行成员</div>
                ) : (
                  <div className="col" style={{ gap: 2 }}>
                    {activeTeam.members.map(mb => {
                      const dotCls =
                        mb.status === 'running'
                          ? 'run breath'
                          : mb.status === 'completed' || mb.status === 'verified'
                            ? 'ok'
                            : mb.status === 'waiting' || mb.status === 'blocked'
                              ? 'warn'
                              : 'idle';
                      return (
                        <div
                          key={mb.memberId}
                          style={{ padding: '7px 0', borderBottom: '1px solid var(--lt-border-subtle)' }}
                        >
                          <div className="row" style={{ gap: 8 }}>
                            <i className={`dot ${dotCls}`} />
                            <span style={{ fontWeight: 600, fontSize: 'var(--lt-fs-dense)' }}>
                              {mb.name}
                            </span>
                            <span className="t-meta">{mb.actorRole}</span>
                            <span className="grow" />
                            <span className="badge sm outline">{mb.effort}</span>
                          </div>
                          <div className="row" style={{ gap: 6, margin: '4px 0 0 15px' }}>
                            <span className="t-meta" style={{ fontSize: 11 }}>
                              {mb.status}
                            </span>
                            <span className="tag" style={{ height: 18 }}>
                              <span className="ellipsis">
                                {mb.writeScope?.length ? mb.writeScope.join(', ') : '(只读)'}
                              </span>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="pane-section">
                <div className="pane-section-title">
                  <span className="t-overline">安全门</span>
                </div>
                <div className="row" style={{ gap: 14, fontSize: 'var(--lt-fs-dense)' }}>
                  <span className="row" style={{ gap: 5 }}>
                    <i className="dot ok" />
                    放行 <b className="num">{activeTeam.gateSummary?.allow ?? <UnknownValue />}</b>
                  </span>
                  <span className="row" style={{ gap: 5 }}>
                    <i className="dot err" />
                    拦截 <b className="num">{activeTeam.gateSummary?.deny ?? <UnknownValue />}</b>
                  </span>
                </div>
              </div>

              {bundle.capabilities.features.teamObservability && (
                <div className="pane-section">
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%' }}
                    onClick={() => onNavigateTab('teams')}
                  >
                    在团队视图中深入 <Icon name="chevR" className="icon-14" />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      <SessionConfigModal
        open={showSessionConfig}
        sessionId={selectedSessionId || null}
        sessionTitle={selectedSession?.title}
        bundle={bundle}
        onClose={() => setShowSessionConfig(false)}
        onRefreshBundle={onRefreshBundle}
        onSaved={nextSnap => setSessionConfigSnap(nextSnap)}
        onNotify={onNotify}
      />
    </div>
  );
}
