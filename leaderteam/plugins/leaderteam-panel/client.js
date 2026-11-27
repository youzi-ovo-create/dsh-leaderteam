/**
 * LeaderTeam In-DSH Visual Console (`leaderteam-panel`)
 * Mounts inside DSH Web/Desktop left navigation (`sidebar.panellist` + `main`) and right sidebar (`sidebarRightTabs`)
 * for live DSH upstream model discovery, role/pool configuration, detachable plugin switches,
 * project/task timers, and fixed-external plan archive retrospectives & cleanup.
 */
(function initLeaderTeamPanelClient() {
  const PANEL_ID = 'leaderteam-panel';
  const PANEL_ORDER = 25;
  const ROUTES = {
    STATE: 'api/leaderteam-panel/state',
    DISCOVER: 'api/leaderteam-panel/discover',
    APPLY: 'api/leaderteam-panel/apply',
    ARCHIVE: 'api/leaderteam-panel/archive',
    RETROSPECT: 'api/leaderteam-panel/retrospect',
    CLEAN: 'api/leaderteam-panel/clean',
    SESSION_MODE: 'api/leaderteam-panel/session-mode',
    SESSION_CONFIG: 'api/leaderteam-panel/session-config',
    UPDATE: 'api/leaderteam-panel/update',
    ONBOARDING: 'api/leaderteam-panel/onboarding',
  };
  const ROLE_META = [
    { key: 'leader', label: '领队 (leader)' },
    { key: 'gate', label: '安全门 (gate)' },
    { key: 'discussA', label: '评审 A (discussA)' },
    { key: 'discussB', label: '评审 B (discussB)' },
    { key: 'arbiter', label: '独立裁断 (arbiter)' },
    { key: 'serialReviewer', label: '串行质询 (serialReviewer)' },
    { key: 'directExec', label: '直接执行 (directExec)' },
  ];
  const PLUGIN_META = [
    { key: 'scheduler', label: '弹性并发调度 (leaderteam-scheduler)', desc: '设备负载感知、渐进扩缩容与对话实时限速' },
    { key: 'consensus', label: '有责对称评审与裁断 (leaderteam-consensus)', desc: '双盲有责评审（理由+建议）与独立裁断' },
    { key: 'timerArchive', label: '工程计时与外部计划归档 (leaderteam-timer-archive)', desc: '项目/任务计时、防停滞择优执行、固定外部路径归档与复审' },
    { key: 'panel', label: 'DSH 内置控制台 (leaderteam-panel)', desc: 'DSH 内部模型/角色/归档可视化面板' },
  ];

  let activeHostConnection = null;

  function isDshAppSurface() {
    if (typeof window === 'undefined' || !window || !window.location) return false;
    return window.location.protocol === 'dsh-app:';
  }

  function isHttpWebSurface() {
    if (typeof window === 'undefined' || !window || !window.location) return false;
    const proto = window.location.protocol;
    return proto === 'http:' || proto === 'https:' || proto === 'dsh-app:';
  }

  function isFileDesktopSurface() {
    if (typeof window === 'undefined' || !window || !window.location) return false;
    return window.location.protocol === 'file:';
  }

  function summarizeLocalOverrideParts(ov) {
    if (!ov || !ov.exists) return [];
    const parts = [];
    if (ov.executionPool) parts.push('team.executionPool');
    if (ov.leaderModelPolicy) parts.push('team.leaderModelPolicy');
    if (Array.isArray(ov.roles) && ov.roles.length > 0) parts.push('roles(' + ov.roles.join(', ') + ')');
    if (Array.isArray(ov.models) && ov.models.length > 0) parts.push('models(' + ov.models.join(', ') + ')');
    return parts;
  }

  function formatMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '0s';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return min + 'm ' + remSec + 's';
    const hr = Math.floor(min / 60);
    return hr + 'h ' + (min % 60) + 'm';
  }

  async function postApi(route, body) {
    const reqInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    };
    const absPath = '/' + String(route || '').replace(/^\/+/, '');
    const customConn =
      (activeHostConnection && typeof activeHostConnection.fetch === 'function' ? activeHostConnection : null) ||
      (typeof window !== 'undefined' && window && window.__DSH_CONNECTION__ && typeof window.__DSH_CONNECTION__.fetch === 'function'
        ? window.__DSH_CONNECTION__
        : null) ||
      (typeof window !== 'undefined' && window && window.__DSH_TRANSPORT__ && typeof window.__DSH_TRANSPORT__.fetch === 'function'
        ? window.__DSH_TRANSPORT__
        : null);

    let res;
    if (customConn) {
      res = await customConn.fetch(absPath, reqInit);
    } else if (isDshAppSurface()) {
      res = await fetch(absPath, Object.assign({}, reqInit, { credentials: 'include' }));
    } else if (isFileDesktopSurface()) {
      if (typeof fetch !== 'function') {
        throw new Error('当前处于 DSH Desktop (file://) 本地宿主模式；请在终端运行 npx lt-ui 或 dsh web 打开工作台。');
      }
      try {
        res = await fetch(route, reqInit);
      } catch {
        throw new Error('当前处于 DSH Desktop (file://) 本地宿主模式，相对 HTTP 面板路由不可达；请在终端运行 npx lt-ui 或 dsh web 打开工作台。');
      }
    } else {
      res = await fetch(route, reqInit);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {}
    if (!res.ok || !json || json.ok !== true) {
      const msg = (json && json.error && json.error.message)
        ? json.error.message
        : ('HTTP ' + res.status);
      const err = new Error(msg);
      if (json && json.error) {
        err.code = json.error.code || null;
        err.details = json.error.details || null;
      }
      err.status = res.status;
      throw err;
    }
    return json.value;
  }

  function isStalePanelModeSnapshot(prevSnap, nextSnap) {
    if (!prevSnap || !nextSnap) return false;
    if (prevSnap.sessionId && nextSnap.sessionId && prevSnap.sessionId !== nextSnap.sessionId) return false;
    if (
      Number.isInteger(prevSnap.switchCount) &&
      Number.isInteger(nextSnap.switchCount) &&
      nextSnap.switchCount < prevSnap.switchCount
    ) {
      return true;
    }
    return false;
  }

  function mergeIncomingSessionModes(prevList, nextList, opts) {
    const prevArr = Array.isArray(prevList) ? prevList : [];
    const nextArr = Array.isArray(nextList) ? nextList : [];
    const epochStale = Boolean(opts && opts.epochStale);
    const authSid = opts && opts.authoritativeSid ? String(opts.authoritativeSid) : null;
    const authSnap = opts && opts.authoritativeModeState ? opts.authoritativeModeState : null;
    const prevById = new Map();
    for (let i = 0; i < prevArr.length; i++) {
      const p = prevArr[i];
      if (p && p.sessionId) prevById.set(p.sessionId, p);
    }
    return nextArr.map(item => {
      if (!item || !item.sessionId) return item;
      const existing = prevById.get(item.sessionId);
      if (authSid && item.sessionId === authSid && authSnap) {
        if (existing && isStalePanelModeSnapshot(existing.modeState, authSnap)) {
          return existing;
        }
        return Object.assign({}, item, {
          executionMode: authSnap.mode,
          isLtSession: authSnap.isLtSession,
          canSwitchMode: authSnap.canSwitch,
          modeBusyReason: authSnap.busyReason,
          modeState: authSnap,
        });
      }
      if (!existing) return item;
      if (epochStale || isStalePanelModeSnapshot(existing.modeState, item.modeState)) {
        const keepSnap = existing.modeState || item.modeState;
        return Object.assign({}, item, {
          executionMode: existing.executionMode !== undefined ? existing.executionMode : item.executionMode,
          isLtSession: existing.isLtSession !== undefined ? existing.isLtSession : item.isLtSession,
          canSwitchMode: existing.canSwitchMode !== undefined ? existing.canSwitchMode : item.canSwitchMode,
          modeBusyReason: existing.modeBusyReason !== undefined ? existing.modeBusyReason : item.modeBusyReason,
          ...(keepSnap ? { modeState: keepSnap } : {}),
        });
      }
      return item;
    });
  }

  function createLeaderTeamPanelClient(requireFn) {
    const React = requireFn('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const useRefCompat = typeof React.useRef === 'function'
      ? React.useRef
      : function useRefFallback(initialValue) {
          const pair = useState({ current: initialValue });
          return pair[0];
        };

    function OriginMark(props) {
      const size = (props && typeof props.size === 'number') ? props.size : 18;
      const ink = (props && props.ink) || 'currentColor';
      const brand = (props && props.brand) || '#9C5B2E';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 22 22',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flexShrink: 0 },
        },
        h('circle', { cx: 11, cy: 6, r: 4.25, stroke: ink, strokeWidth: 1.5 }),
        h('line', { x1: 11, y1: 12.6, x2: 11, y2: 21, stroke: brand, strokeWidth: 1.5, strokeLinecap: 'round' })
      );
    }

    function resolvePanelTokens() {
      let theme = 'white';
      try {
        const raw = typeof localStorage !== 'undefined' ? (localStorage.getItem('lt.appearance') || localStorage.getItem('lt-ui-preferences-v1')) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.theme === 'dark' || parsed.theme === 'heluoxu' || parsed.theme === 'white')) {
            theme = parsed.theme;
          }
        }
      } catch {}
      try {
        if (theme === 'white' && typeof document !== 'undefined' && document && document.documentElement) {
          const cls = String(document.documentElement.className || '');
          const dt = document.documentElement.getAttribute && document.documentElement.getAttribute('data-theme');
          if (/\bdark\b/i.test(cls) || dt === 'dark') {
            theme = 'dark';
          } else if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            theme = 'dark';
          }
        }
      } catch {}

      if (theme === 'dark') {
        return {
          bgCanvas: '#0D0F12',
          bgSubtle: '#121519',
          bgSurface: '#16191E',
          bgInset: '#101317',
          fgPrimary: '#E5E8EC',
          fgSecondary: '#AAB2BC',
          fgMuted: '#8A939E',
          borderSubtle: 'rgba(230,234,239,0.09)',
          borderControl: '#434B56',
          accent: '#6FB1C9',
          onAccent: '#081317',
          info: '#6FB1C9',
          infoBg: 'rgba(111,177,201,0.14)',
          success: '#62B892',
          successBg: 'rgba(98,184,146,0.14)',
          warning: '#DDAB55',
          warningBg: 'rgba(221,171,85,0.14)',
          danger: '#EE8577',
          dangerBg: 'rgba(238,133,119,0.14)',
          seal: '#E28C79',
          brand: '#D29A68',
          radiusBtn: '6px',
        };
      }
      if (theme === 'heluoxu') {
        return {
          bgCanvas: '#ECE8DF',
          bgSubtle: '#F2EFE8',
          bgSurface: '#F8F6F1',
          bgInset: '#EFEBE3',
          fgPrimary: '#1A1916',
          fgSecondary: '#504D46',
          fgMuted: '#6A665E',
          borderSubtle: 'rgba(26,25,22,0.11)',
          borderControl: '#ABA597',
          accent: '#9C5B2E',
          onAccent: '#FFFDF9',
          info: '#2A657C',
          infoBg: '#E6EEF0',
          success: '#36705A',
          successBg: '#E5EFE8',
          warning: '#8A6113',
          warningBg: '#F5EBD6',
          danger: '#A3263F',
          dangerBg: '#F6E6E8',
          seal: '#92544E',
          brand: '#9C5B2E',
          radiusBtn: '999px',
        };
      }
      return {
        bgCanvas: '#F2F3F5',
        bgSubtle: '#F8F9FA',
        bgSurface: '#FFFFFF',
        bgInset: '#F3F5F7',
        fgPrimary: '#15191E',
        fgSecondary: '#47505A',
        fgMuted: '#67707B',
        borderSubtle: 'rgba(21,25,30,0.09)',
        borderControl: '#B4BBC3',
        accent: '#2A657C',
        onAccent: '#FFFFFF',
        info: '#2A657C',
        infoBg: '#E9F2F5',
        success: '#2B6F57',
        successBg: '#E7F3ED',
        warning: '#8F620E',
        warningBg: '#FBF2DF',
        danger: '#B2372C',
        dangerBg: '#FBECEA',
        seal: '#A63D2F',
        brand: '#9C5B2E',
        radiusBtn: '6px',
      };
    }

    function PanelIcon(props) {
      const size = (props && typeof props.size === 'number') ? props.size : 18;
      return h(OriginMark, { size, ink: 'currentColor', brand: '#9C5B2E' });
    }

    function TabTitle() {
      return h('span', { style: { fontWeight: 600, fontSize: '12px' } }, 'LeaderTeam');
    }

    function ConsoleView(props) {
      const compact = props && props.host === 'sidebar';
      const [tab, setTab] = useState('models');
      const [teamId, setTeamId] = useState('');
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [notice, setNotice] = useState(null);
      const [warningMsg, setWarningMsg] = useState(null);
      const [error, setError] = useState(null);
      const [saveTarget, setSaveTarget] = useState('local');
      const [isDirty, setIsDirty] = useState(false);

      // Draft edits for roles & pool
      const [draftRoles, setDraftRoles] = useState({});
      const [draftPool, setDraftPool] = useState([]);
      const [newModelRoute, setNewModelRoute] = useState('');
      const [newModelProvider, setNewModelProvider] = useState('magpie');
      const [newModelEfforts, setNewModelEfforts] = useState('low,medium,high');

      // Session execution modes (Single / Team)
      const [sessionModes, setSessionModes] = useState([]);
      const [switchingMap, setSwitchingMap] = useState({});
      const modeMutationEpochRef = useRefCompat(0);

      // Archive filters & detail
      const [catFilter, setCatFilter] = useState('');
      const [stateFilter, setStateFilter] = useState('');
      const [archivePlans, setArchivePlans] = useState([]);
      const [selectedPlan, setSelectedPlan] = useState(null);
      const [retroNotes, setRetroNotes] = useState('');
      const [cleanPreview, setCleanPreview] = useState(null);
      const [cleanDays, setCleanDays] = useState('');
      const [updateCheckInfo, setUpdateCheckInfo] = useState(null);
      const [quickProvider, setQuickProvider] = useState('deepseek');
      const [quickApiKey, setQuickApiKey] = useState('');

      const hydrateFromState = useCallback((snap, opts) => {
        setData(snap);
        const keepDrafts = Boolean(opts && opts.preserveDirty);
        const epochStale = Boolean(opts && opts.epochStale);
        if (snap && snap.configSnapshot && !keepDrafts) {
          const rMap = {};
          ROLE_META.forEach(({ key }) => {
            const cur = snap.configSnapshot.roles && snap.configSnapshot.roles[key];
            if (cur) rMap[key] = structuredClone ? structuredClone(cur) : JSON.parse(JSON.stringify(cur));
          });
          setDraftRoles(rMap);
          setDraftPool(Array.isArray(snap.configSnapshot.executionPool) ? snap.configSnapshot.executionPool.slice() : []);
          setIsDirty(false);
        } else if (keepDrafts && opts && opts.addedPoolRoute) {
          const r = opts.addedPoolRoute;
          setDraftPool(prev => (prev.includes(r) ? prev : prev.concat([r])));
        }
        if (snap && Array.isArray(snap.sessionModes)) {
          setSessionModes(prev => mergeIncomingSessionModes(prev, snap.sessionModes, { epochStale }));
        }
        if (snap && snap.archive && Array.isArray(snap.archive.recentPlans)) {
          setArchivePlans(snap.archive.recentPlans);
        }
      }, []);

      const loadState = useCallback(async (opts) => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        try {
          const snap = await postApi(ROUTES.STATE, opts || {});
          hydrateFromState(snap, {
            preserveDirty: false,
            epochStale: modeEpoch !== modeMutationEpochRef.current,
          });
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      }, [hydrateFromState]);

      useEffect(() => {
        void loadState({});
      }, [loadState]);

      const onDiscoverUpstream = async (probeEndpoints) => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.DISCOVER, { probeEndpoints: Boolean(probeEndpoints) });
          hydrateFromState(res.state, {
            preserveDirty: isDirty,
            epochStale: modeEpoch !== modeMutationEpochRef.current,
          });
          const count = (res.catalog && Array.isArray(res.catalog.models)) ? res.catalog.models.length : 0;
          setNotice('已同步 DSH 上游模型目录，共发现 ' + count + ' 个上游模型' + (isDirty ? '（已保留当前未保存的角色草稿）' : '') + '。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onSaveModelsAndRoles = async () => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        setWarningMsg(null);
        try {
          const setRoles = ROLE_META.map(({ key }) => {
            const cur = draftRoles[key];
            if (!cur || !cur.route || !cur.effort) return null;
            return {
              ...cur,
              role: key,
              route: cur.route,
              effort: cur.effort,
            };
          }).filter(Boolean);
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: {
              setRoles,
              poolSet: draftPool,
            },
          });
          hydrateFromState(res.state, {
            preserveDirty: false,
            epochStale: modeEpoch !== modeMutationEpochRef.current,
          });
          const shadowed = (res && Array.isArray(res.shadowedByLocal) && res.shadowedByLocal.length > 0)
            ? res.shadowedByLocal
            : (res && res.applyResult && Array.isArray(res.applyResult.shadowedByLocal) ? res.applyResult.shadowedByLocal : []);
          const warns = (res && Array.isArray(res.warnings) && res.warnings.length > 0)
            ? res.warnings
            : (res && res.applyResult && Array.isArray(res.applyResult.warnings) ? res.applyResult.warnings : []);
          if (shadowed.length > 0) {
            setWarningMsg('基础配置已写入磁盘，但当前被本机覆盖文件 leaderteam.local.json 遮蔽的字段未在运行时生效：[' + shadowed.join(', ') + ']。可点击右侧「清除本机覆盖」立即生效。');
          } else if (warns.length > 0) {
            setWarningMsg(warns.join('；'));
          }
          setNotice('已保存：所有空闲会话已立即热更新；执行中的会话将在当前回合结束后自动切换。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onAlignLeaderSession = async (sessionId, mode) => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: {
              alignLeaderSession: { sessionId, mode },
            },
          });
          hydrateFromState(res.state, {
            preserveDirty: false,
            epochStale: modeEpoch !== modeMutationEpochRef.current,
          });
          setNotice(mode === 'session-to-config'
            ? ('已将会话 ' + sessionId + ' 的领队模型切换为配置模型。')
            : ('已将配置领队更新为会话 ' + sessionId + ' 当前所选模型。'));
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onSetSessionLeaderOverride = async (sid, nextRoute) => {
        if (!sid) return;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          if (!nextRoute) {
            const res = await postApi(ROUTES.SESSION_CONFIG, { action: 'reset', sessionId: sid });
            if (res && res.state) hydrateFromState(res.state, { preserveDirty: isDirty });
            setNotice(res.appliedImmediately ? ('会话 ' + sid + ' 已恢复跟随全局配置。') : ('会话 ' + sid + ' 正在执行，已暂存重置并在当前回合结束后生效。'));
          } else {
            const res = await postApi(ROUTES.SESSION_CONFIG, {
              action: 'set',
              sessionId: sid,
              syncAllRolesToLeader: true,
              patch: { roles: { leader: { route: nextRoute } } },
            });
            if (res && res.state) hydrateFromState(res.state, { preserveDirty: isDirty });
            setNotice(res.appliedImmediately ? ('会话 ' + sid + ' 已切换为专属模型 ' + nextRoute + '（不影响全局及其他会话）。') : ('会话 ' + sid + ' 正在执行，已暂存模型切换并在安全边界自动生效。'));
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onAutoWireHostModels = async () => {
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.SESSION_CONFIG, { action: 'auto-adopt-host' });
          if (res && res.state) hydrateFromState(res.state, { preserveDirty: false });
          setNotice('已根据当前 DSH 已连接模型一键自动配齐全部角色与成员执行池，所有空闲会话已立即生效！');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onClearLocalOverrides = async () => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        setWarningMsg(null);
        try {
          const res = await postApi(ROUTES.APPLY, {
            target: 'local',
            changes: { clearLocalOverrides: true },
          });
          hydrateFromState(res.state, {
            preserveDirty: false,
            epochStale: modeEpoch !== modeMutationEpochRef.current,
          });
          setNotice('已清除本机覆盖 (leaderteam.local.json 中的模型、执行池与角色覆盖)，正式基础配置已恢复生效。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onAddCustomModel = async () => {
        const route = newModelRoute.trim();
        if (!route) return;
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const efforts = newModelEfforts.split(',').map(s => s.trim()).filter(Boolean);
          const effList = efforts.length ? efforts : ['none'];
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: {
              upsertModels: [{
                route,
                provider: newModelProvider.trim() || 'magpie',
                efforts: effList,
                defaultEffort: effList[0],
                enableInPool: true,
              }],
            },
          });
          hydrateFromState(res.state, {
            preserveDirty: isDirty,
            addedPoolRoute: route,
            epochStale: modeEpoch !== modeMutationEpochRef.current,
          });
          setNewModelRoute('');
          setNotice('已登记模型 ' + route + ' 并加入成员执行池。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onTogglePlugin = async (pluginKey, nextVal) => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: { setPlugins: { [pluginKey]: nextVal } },
          });
          hydrateFromState(res.state, { epochStale: modeEpoch !== modeMutationEpochRef.current });
          setNotice('插件 ' + pluginKey + ' 已切换为 ' + (nextVal ? '启用' : '拆卸停用') + '。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onTogglePowerMonitor = async (nextVal) => {
        const modeEpoch = modeMutationEpochRef.current;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: { setPowerMonitor: { enabled: nextVal } },
          });
          hydrateFromState(res.state, { epochStale: modeEpoch !== modeMutationEpochRef.current });
          setNotice('电池感知式安全收尾已切换为 ' + (nextVal ? '启用' : '停用') + '。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onFilterArchive = async (nextCat, nextState) => {
        setCatFilter(nextCat);
        setStateFilter(nextState);
        try {
          const res = await postApi(ROUTES.ARCHIVE, {
            category: nextCat || undefined,
            lifecycleState: nextState || undefined,
            limit: 50,
          });
          setArchivePlans(res.plans || []);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      };

      const onSelectPlan = async (planId) => {
        try {
          const res = await postApi(ROUTES.ARCHIVE, { planId });
          setSelectedPlan(res.plan);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      };

      const onRunRetrospect = async (planId) => {
        setLoading(true);
        setError(null);
        try {
          const res = await postApi(ROUTES.RETROSPECT, { planId, notes: retroNotes });
          setSelectedPlan(res.plan);
          setNotice('已生成执行后复审记录 (' + res.retrospective.retroId + ')。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onCleanArchive = async (confirmExecute) => {
        const trimmedDays = cleanDays.trim();
        let daysNum;
        if (trimmedDays !== '') {
          daysNum = Number(trimmedDays);
          if (!Number.isFinite(daysNum) || daysNum < 0) {
            setError('清理天数必须为大于等于 0 的有效数字');
            return;
          }
        }
        setLoading(true);
        setError(null);
        try {
          const hasFilter = Boolean(catFilter || typeof daysNum === 'number');
          const res = await postApi(ROUTES.CLEAN, {
            category: catFilter || undefined,
            olderThanDays: typeof daysNum === 'number' ? daysNum : undefined,
            all: !hasFilter,
            dryRun: !confirmExecute,
            confirm: Boolean(confirmExecute),
          });
          setCleanPreview(res);
          if (confirmExecute) {
            setArchivePlans(res.recentPlans || []);
            setSelectedPlan(null);
            setNotice('已清理外部归档计划 ' + res.removedCount + ' 条。');
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onRefreshSessionModes = async () => {
        const modeEpoch = modeMutationEpochRef.current;
        setError(null);
        try {
          const res = await postApi(ROUTES.SESSION_MODE, { action: 'list' });
          const epochStale = modeEpoch !== modeMutationEpochRef.current;
          if (res && Array.isArray(res.sessions)) {
            setSessionModes(prev => mergeIncomingSessionModes(prev, res.sessions, { epochStale }));
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      };

      const onSwitchSessionMode = async (sid, nextMode) => {
        if (!sid || !nextMode) return;
        modeMutationEpochRef.current += 1;
        setSwitchingMap(prev => Object.assign({}, prev || {}, { [sid]: true }));
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.SESSION_MODE, {
            action: 'set',
            sessionId: sid,
            mode: nextMode,
          });
          modeMutationEpochRef.current += 1;
          if (res && Array.isArray(res.sessions)) {
            setSessionModes(prev =>
              mergeIncomingSessionModes(prev, res.sessions, {
                epochStale: false,
                authoritativeSid: sid,
                authoritativeModeState: res.modeState || null,
              })
            );
          } else if (res && res.modeState) {
            setSessionModes(prev => prev.map(s => {
              if (s.sessionId !== sid) return s;
              if (isStalePanelModeSnapshot(s.modeState, res.modeState)) return s;
              return Object.assign({}, s, {
                executionMode: res.modeState.mode,
                canSwitchMode: res.modeState.canSwitch,
                modeBusyReason: res.modeState.busyReason,
                modeState: res.modeState,
              });
            }));
          }
          setNotice('会话 ' + sid + ' 已切换为 ' + (nextMode === 'single' ? 'Single 单代理直执' : 'Team 团队协作') + ' 模式（0 次模型调用）。');
        } catch (e) {
          modeMutationEpochRef.current += 1;
          if (e && e.details && e.details.modeState) {
            const ms = e.details.modeState;
            setSessionModes(prev => prev.map(s => {
              if (s.sessionId !== sid) return s;
              if (isStalePanelModeSnapshot(s.modeState, ms)) return s;
              return Object.assign({}, s, {
                executionMode: ms.mode,
                isLtSession: ms.isLtSession,
                canSwitchMode: ms.canSwitch,
                modeBusyReason: ms.busyReason,
                modeState: ms,
              });
            }));
          }
          const prefix = e && e.code === 'MODE_SWITCH_BUSY' ? '无法切换会话模式（当前忙碌）：' : '切换会话模式失败：';
          setError(prefix + (e && e.message ? e.message : String(e)));
        } finally {
          setSwitchingMap(prev => {
            const next = Object.assign({}, prev || {});
            delete next[sid];
            return next;
          });
        }
      };

      const models = (data && Array.isArray(data.unifiedModels)) ? data.unifiedModels : [];
      const tok = resolvePanelTokens();
      const firstSid = sessionModes && sessionModes[0] && sessionModes[0].sessionId ? sessionModes[0].sessionId : '';
      const dshAppSurface = isDshAppSurface();
      const ltBaseHref = dshAppSurface ? '/lt/' : './lt/';
      const ltNativeHref = firstSid ? (ltBaseHref + '#/workbench?session=' + encodeURIComponent(firstSid)) : ltBaseHref;
      const onOpenLtInCurrentWindow = dshAppSurface
        ? function handleDshAppNavigate(e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            if (typeof window !== 'undefined' && window.location && typeof window.location.assign === 'function') {
              window.location.assign(ltNativeHref);
            } else if (typeof window !== 'undefined' && window.location) {
              window.location.href = ltNativeHref;
            }
          }
        : undefined;
      const cardStyle = {
        border: '1px solid ' + tok.borderSubtle,
        borderRadius: '6px',
        padding: compact ? '10px 12px' : '14px 16px',
        marginBottom: '10px',
        background: tok.bgSurface,
        color: tok.fgPrimary,
      };
      const btnStyle = (primary) => ({
        padding: compact ? '4px 9px' : '5px 11px',
        borderRadius: tok.radiusBtn,
        border: '1px solid ' + (primary ? tok.accent : tok.borderControl),
        background: primary ? tok.accent : tok.bgSurface,
        color: primary ? tok.onAccent : tok.fgPrimary,
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 500,
        marginRight: '6px',
      });
      const inputStyle = {
        padding: '4px 8px',
        borderRadius: '4px',
        border: '1px solid ' + tok.borderControl,
        background: tok.bgSurface,
        color: tok.fgPrimary,
        fontSize: '12px',
      };

      return h(
        'div',
        {
          style: {
            padding: compact ? '10px' : '18px 22px',
            height: '100%',
            overflowY: 'auto',
            fontSize: compact ? '12.5px' : '13px',
            lineHeight: 1.5,
            boxSizing: 'border-box',
            background: tok.bgSubtle,
            color: tok.fgPrimary,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        // Header (Heluo 始 mark + compact actions)
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              marginBottom: '10px',
              paddingBottom: '10px',
              borderBottom: '1px solid ' + tok.borderSubtle,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h(OriginMark, { size: compact ? 18 : 22, ink: tok.fgPrimary, brand: tok.brand }),
            h('div', null,
              h('div', { style: { fontSize: compact ? '14px' : '16px', fontWeight: 600, color: tok.fgPrimary } }, 'Leader Team'),
              h('div', { style: { fontSize: '11px', color: tok.fgMuted } }, '河洛 · 上游模型 · 双模式 · 可拆卸模块 · 外部归档')
            )
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' } },
            isHttpWebSurface()
              ? h(
                'a',
                {
                  href: ltNativeHref,
                  onClick: onOpenLtInCurrentWindow,
                  style: {
                    display: 'inline-block',
                    padding: compact ? '4px 10px' : '5px 12px',
                    borderRadius: tok.radiusBtn,
                    border: '1px solid ' + tok.accent,
                    background: tok.accent,
                    color: tok.onAccent,
                    textDecoration: 'none',
                    fontWeight: 500,
                    fontSize: '12px',
                    marginRight: '6px',
                  },
                  title: '携带当前会话切换至 LT 原生工作台（共享运行时与活跃团队，切换零中断）',
                },
                dshAppSurface ? '打开 /lt/ →' : '打开 /lt/ ↗'
              )
              : null,
            h('button', { style: btnStyle(false), onClick: () => loadState({ forceDiscover: true }), disabled: loading }, loading ? '刷新中…' : '刷新状态'),
            h('button', { style: btnStyle(false), onClick: () => onDiscoverUpstream(true), disabled: loading }, '探测上游模型 (/v1/models)')
          )
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              padding: '8px 12px',
              marginBottom: '10px',
              borderLeft: '2px solid ' + tok.brand,
              borderRadius: '4px',
              background: tok.infoBg,
              color: tok.fgSecondary,
              fontSize: '12px',
            },
          },
          h('span', null, 'LT 原生工作台提供完整 Magpie 网关、多 Key 池、角色回退链、规划拓扑、衡账分析及四套河洛主题，与当前 DSH 前端共享同一会话与团队。'),
          isHttpWebSurface()
            ? h('a', { href: ltNativeHref, onClick: onOpenLtInCurrentWindow, style: { color: tok.accent, fontWeight: 600, whiteSpace: 'nowrap', textDecoration: 'none' } }, '进入 /lt/ →')
            : h('span', { style: { color: tok.accent, fontWeight: 600, whiteSpace: 'nowrap' } }, '终端运行 npx lt-ui')
        ),
        error ? h('div', { style: { padding: '8px 10px', borderRadius: '6px', background: tok.dangerBg, color: tok.danger, marginBottom: '10px', fontSize: '12px' } }, '错误：' + error) : null,
        (() => {
          const localOvParts = summarizeLocalOverrideParts(data && data.configSnapshot && data.configSnapshot.localOverrides);
          if (!warningMsg && localOvParts.length === 0) return null;
          return h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                padding: '8px 10px',
                borderRadius: '6px',
                background: tok.warningBg,
                color: tok.fgPrimary,
                marginBottom: '10px',
                fontSize: '12px',
              },
            },
            h(
              'span',
              null,
              warningMsg || ('当前存在本机覆盖 (leaderteam.local.json)：' + localOvParts.join('、') + (saveTarget === 'base' ? ' — 写入基础配置时同名字段将被本机覆盖遮蔽。' : ''))
            ),
            localOvParts.length > 0
              ? h('button', { style: btnStyle(false), onClick: onClearLocalOverrides, disabled: loading }, '清除本机覆盖 (Clear Local Overrides)')
              : null
          );
        })(),
        notice ? h('div', { style: { padding: '8px 10px', borderRadius: '6px', background: tok.successBg, color: tok.success, marginBottom: '10px', fontSize: '12px' } }, notice) : null,
        (data && Array.isArray(data.leaderSessionChecks) ? data.leaderSessionChecks.filter(s => s && s.status !== 'match' && s.status !== 'synced' && s.status !== 'follow-default' && s.policy !== 'off' && s.policy !== 'follow') : []).map(s =>
          h('div', {
            key: s.sessionId,
            style: {
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid ' + tok.warning,
              background: tok.warningBg,
              color: tok.fgPrimary,
              marginBottom: '10px',
              fontSize: '12px',
            },
          },
          h('div', { style: { fontWeight: 700, marginBottom: '4px' } },
            (s.blocked ? '⚠️ 领队模型不一致（enforce 校验拦截中）：' : '提示（领队模型不一致）：') + s.sessionId
          ),
          h('div', { style: { marginBottom: '6px', opacity: 0.9 } },
            '当前会话运行：' + (s.actual ? (s.actual.provider + '/' + s.actual.model + ' (' + (s.actual.effort || 'auto') + ')') : '未知') +
            ' ｜ 配置领队：' + (s.configured ? (s.configured.provider + '/' + s.configured.model + ' (' + s.configured.effort + ')') : '未知') +
            (s.workspace ? (' ｜ 工作区：' + s.workspace) : '')
          ),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            h('button', { style: btnStyle(true), onClick: () => onAlignLeaderSession(s.sessionId, 'session-to-config'), disabled: loading }, '一键切换该会话模型以匹配配置'),
            !s.started ? h('button', { style: btnStyle(false), onClick: () => onAlignLeaderSession(s.sessionId, 'config-to-session'), disabled: loading }, '将当前会话模型设为配置领队') : null
          ))
        ),
        // Navigation Tabs
        h(
          'div',
          { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '12px', borderBottom: '1px solid ' + tok.borderSubtle, paddingBottom: '8px' } },
          [
            ['models', '模型与角色 (' + models.length + ')'],
            ['usage', '实际模型与用量'],
            ['plugins', '可拆卸插件'],
            ['timers', '工程计时器'],
            ['archive', '历史计划归档 (' + archivePlans.length + ')'],
            ['updates', '版本更新与新手引导'],
          ].map(([id, label]) =>
            h('button', { key: id, style: btnStyle(tab === id), onClick: () => setTab(id) }, label)
          )
        ),

        // TAB 1: Models, Roles & In-Session Dual Mode
        tab === 'models' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' } },
              h('strong', null, '会话内执行模式 (Single / Team)'),
              h('button', { style: btnStyle(false), onClick: onRefreshSessionModes, disabled: loading || Object.keys(switchingMap || {}).length > 0 }, '刷新会话模式')
            ),
            h('div', { style: { fontSize: '11.5px', color: tok.fgMuted, marginBottom: '8px' } },
              '仅在会话空闲时允许在 Team（领队编排 + 子代理并发 + 双评审）与 Single（主代理直执 + 安全门守护 · 零团队开销）之间热切换；0 次模型调用。'
            ),
            sessionModes.length === 0
              ? h('div', { style: { fontSize: '12px', color: tok.fgMuted } }, '暂无活跃或最近的会话记录。创建 LeaderTeam 会话后可在此一键切换 Single / Team。')
              : sessionModes.map(s => {
                const ms = s.modeState || {};
                const isLt = s.isLtSession !== false && ms.isLtSession !== false;
                const curMode = (ms.mode || s.executionMode) === 'single' ? 'single' : 'team';
                const canSwitch = isLt && ms.canSwitch !== false && s.canSwitchMode !== false;
                const busyReason = ms.busyReason || s.modeBusyReason || null;
                const targetMode = curMode === 'team' ? 'single' : 'team';
                const targetLabel = targetMode === 'single' ? '切换为 Single' : '切换为 Team';
                const isSwitchingThis = Boolean(switchingMap && switchingMap[s.sessionId]);
                return h(
                  'div',
                  {
                    key: s.sessionId,
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                      padding: '8px 0',
                      borderTop: '1px solid ' + tok.borderSubtle,
                      fontSize: '12px',
                    },
                  },
                  h('div', { style: { minWidth: '180px', flex: 1 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                      h('strong', null, s.title || s.sessionId),
                      h(
                        'span',
                        {
                          style: {
                            padding: '1px 6px',
                            borderRadius: '3px',
                            border: '1px solid ' + (!isLt ? tok.borderControl : curMode === 'single' ? tok.seal : 'transparent'),
                            background: !isLt ? 'transparent' : curMode === 'single' ? 'transparent' : tok.infoBg,
                            color: !isLt ? tok.fgMuted : curMode === 'single' ? tok.seal : tok.info,
                            fontSize: '10.5px',
                            fontWeight: 600,
                          },
                        },
                        !isLt ? 'DSH 原生' : (curMode === 'single' ? 'Single' : 'Team')
                      ),
                      h(
                        'span',
                        { style: { fontSize: '11px', color: !isLt ? tok.fgMuted : (canSwitch ? tok.success : tok.warning) } },
                        !isLt ? '非 LT 预设会话' : (canSwitch ? '● 空闲可切换' : '● 忙碌锁定')
                      )
                    ),
                    h('div', { style: { fontSize: '11px', opacity: 0.7, fontFamily: 'monospace' } },
                      s.sessionId + (busyReason ? ' — ' + busyReason : '')
                    )
                  ),
                  isLt
                    ? h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                      h(
                        'select',
                        {
                          value: s.hasSessionConfigOverride ? (s.effectiveLeaderRoute || '') : '',
                          onChange: e => onSetSessionLeaderOverride(s.sessionId, e.target.value),
                          disabled: loading,
                          title: '仅修改当前会话专属模型（不影响全局与其他会话；空闲立即生效，运行中安全边界生效）',
                          style: { ...inputStyle, maxWidth: '185px' },
                        },
                        h('option', { value: '' }, s.hasPendingSessionConfig ? '⏳ 待安全边界切换' : ('跟随全局 (' + (s.effectiveLeaderRoute || '默认') + ')')),
                        models.map(m => h('option', { key: m.route, value: m.route }, '本会话专属: ' + m.route))
                      ),
                      h(
                        'button',
                        {
                          style: btnStyle(curMode === 'team'),
                          disabled: loading || isSwitchingThis || !canSwitch,
                          title: canSwitch ? ('空闲热切换会话执行模式：' + targetLabel) : (busyReason || '当前会话忙碌中，仅允许空闲时切换'),
                          onClick: () => onSwitchSessionMode(s.sessionId, targetMode),
                        },
                        isSwitchingThis ? '切换中…' : targetLabel
                      )
                    )
                    : h('span', { style: { fontSize: '11px', opacity: 0.65 } }, '仅 LT 会话可切换')
                );
              })
          ),
          h('div', { style: cardStyle },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' } },
              h('strong', null, '治理角色与领队模型（空闲会话立即热生效 · 支持任意 DSH 上游模型）'),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                h('button', { style: btnStyle(false), onClick: onAutoWireHostModels, disabled: loading }, '✨ 一键用已连接模型配齐全部角色'),
                h('label', { style: { fontSize: '12px' } },
                  '写入目标：',
                  h('select', { value: saveTarget, onChange: e => setSaveTarget(e.target.value), style: { ...inputStyle, marginLeft: '4px' } },
                    h('option', { value: 'local' }, '本机覆盖 (leaderteam.local.json)'),
                    h('option', { value: 'base' }, '基础配置 (leaderteam.config.json)')
                  )
                )
              )
            ),
            ROLE_META.map(({ key, label }) => {
              const cur = draftRoles[key] || { route: '', effort: '' };
              const selectedSpec = models.find(m => m.route === cur.route);
              const efforts = (selectedSpec && Array.isArray(selectedSpec.efforts) && selectedSpec.efforts.length)
                ? selectedSpec.efforts
                : [cur.effort || 'none'];
              return h(
                'div',
                { key, style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' } },
                h('span', { style: { minWidth: '140px', fontSize: '12px', fontWeight: 600 } }, label),
                h(
                  'select',
                  {
                    style: { ...inputStyle, flex: 1, minWidth: '180px' },
                    value: cur.route,
                    onChange: e => {
                      const nextRoute = e.target.value;
                      const sp = models.find(m => m.route === nextRoute);
                      const nextEff = sp ? (sp.defaultEffort || sp.efforts[0] || 'none') : 'none';
                      setIsDirty(true);
                      setDraftRoles(prev => ({ ...prev, [key]: { ...cur, route: nextRoute, effort: nextEff } }));
                    },
                  },
                  models.map(m => h('option', { key: m.route, value: m.route }, m.route + ' [' + m.provider + ' · ' + m.family + ']'))
                ),
                h(
                  'select',
                  {
                    style: { ...inputStyle, width: '95px' },
                    value: cur.effort,
                    onChange: e => {
                      setIsDirty(true);
                      setDraftRoles(prev => ({ ...prev, [key]: { ...cur, effort: e.target.value } }));
                    },
                  },
                  efforts.map(ef => h('option', { key: ef, value: ef }, ef))
                )
              );
            }),
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { style: btnStyle(true), onClick: onSaveModelsAndRoles, disabled: loading }, '保存角色与成员池'),
              isDirty ? h('span', { style: { fontSize: '11px', opacity: 0.75 } }, '● 有未保存的角色或执行池修改') : null
            )
          ),
          h('div', { style: cardStyle },
            h('strong', null, '子代理执行模型池（勾选允许领队调度的上游模型）'),
            h('div', { style: { marginTop: '8px', maxHeight: '240px', overflowY: 'auto' } },
              models.map(m => {
                const checked = draftPool.includes(m.route);
                return h(
                  'label',
                  { key: m.route, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked,
                    onChange: e => {
                      const on = e.target.checked;
                      setIsDirty(true);
                      setDraftPool(prev => on ? (prev.includes(m.route) ? prev : prev.concat([m.route])) : prev.filter(x => x !== m.route));
                    },
                  }),
                  h('span', { style: { fontWeight: 600 } }, m.route),
                  h('span', { style: { opacity: 0.7 } }, '(' + m.provider + ' · 档位: ' + (m.efforts || []).join('/') + ' · ' + m.source + ')')
                );
              })
            )
          ),
          h('div', { style: cardStyle },
            h('strong', null, '手动登记新上游模型'),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
              h('input', { style: { ...inputStyle, width: '110px' }, placeholder: 'provider (如 deepseek)', value: newModelProvider, onChange: e => setNewModelProvider(e.target.value) }),
              h('input', { style: { ...inputStyle, flex: 1, minWidth: '160px' }, placeholder: '路由 <prefix>/<model> (如 deepseek/deepseek-flash)', value: newModelRoute, onChange: e => setNewModelRoute(e.target.value) }),
              h('input', { style: { ...inputStyle, width: '140px' }, placeholder: '档位 (如 none 或 low,high)', value: newModelEfforts, onChange: e => setNewModelEfforts(e.target.value) }),
              h('button', { style: btnStyle(false), onClick: onAddCustomModel, disabled: loading }, '添加模型')
            )
          )
        ) : null,

        tab === 'usage' ? h('div',null,
          h('div',{style:cardStyle},
            h('strong',null,'团队实际调用与分项用量'),
            h('p',null,'治理快照是配置；实际模型取自调用回执。未调用的角色会明确标记。总计包含缓存，不重复计算流式事件；缺失记录不算作零费用。'),
            h('select',{style:inputStyle,value:teamId,onChange:e=>setTeamId(e.target.value)},
              h('option',{value:''},'最近团队'),
              (data.teams||[]).map(x=>h('option',{key:x.teamId,value:x.teamId},x.teamId)))
          ),
          (data.teams||[]).filter(x=>x.teamId === (teamId || data.teams?.[0]?.teamId)).map(team=>h('div',{key:team.teamId},
            team.error ? h('div',{style:cardStyle},'读取失败：'+team.error) : h('div',null,
              h('div',{style:cardStyle},
                h('div',null,'团队：'+team.teamId),
                h('div',{style:{fontSize:'11px',wordBreak:'break-all'}},'冻结治理 SHA256：'+(team.governanceSha256||'历史团队无快照')),
                h('table',{style:{width:'100%',fontSize:'12px'}},
                  h('thead',null,h('tr',null,['角色','配置模型／档位','实际调用','token'].map(x=>h('th',{key:x},x)))),
                  h('tbody',null,(team.roles||[]).map(r=>h('tr',{key:r.role},
                    h('td',null,r.role),h('td',null,r.configured.route+' / '+r.configured.effort),
                    h('td',null,r.called ? r.actualRoutes.join('、')+(r.degraded?'（降级）':'')+' · '+r.calls+'次' : r.requested ? '已发起请求，等待用量回执：'+r.requestRoutes.join('、') : '未调用'),
                    h('td',null,r.called ? r.tokens.totalTokens.toLocaleString()+(r.missingUsage?'（'+r.missingUsage+'次计量缺失）':'') : r.requested ? '待回执' : '—')))))
              ),
              h('div',{style:cardStyle},
                h('strong',null,'用量汇总'+(team.usage.complete?'':'（部分计量待回执或记录缺失）')),
                ['leader','governance','execution'].map((g,i)=>h('div',{key:g},
                  ['主代理','LeaderTeam 治理团队','执行子代理'][i]+'：'+team.usage.groups[g].tokens.totalTokens.toLocaleString()+' token'+(team.usage.groups[g].awaitingUsage?'（尚无用量回执）':'')+(team.usage.groups[g].missingUsage?'（'+team.usage.groups[g].missingUsage+'次计量缺失）':''))),
                h('div',{style:{fontWeight:700,marginTop:'8px'}},(team.usage.complete?'总计：':'已报合计：')+team.usage.total.totalTokens.toLocaleString()+' token'),
                h('div',null,'普通输入 '+team.usage.total.inputTokens.toLocaleString()+' · 缓存读取 '+team.usage.total.cacheReadTokens.toLocaleString()+' · 缓存写入 '+team.usage.total.cacheWriteTokens.toLocaleString()+' · 输出 '+team.usage.total.outputTokens.toLocaleString()),
                h('div',null,'实际费用：未提供'),
                (team.usage.members||[]).map(m=>h('div',{key:m.id,style:{marginTop:'6px'}},m.name+' · '+(m.actualModels.join('、')||'尚无调用回执')+' · '+m.tokens.totalTokens.toLocaleString()+' token'+(m.available?'':'（记录缺失）')))
              )
            )
          ))) : null,

        // TAB 2: Detachable Plugins
        tab === 'plugins' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('strong', null, '可拆卸插件架构（治理开关在新团队生效；Cordis 插件可独立拆卸）'),
            h('div', { style: { fontSize: '12px', opacity: 0.75, marginTop: '4px', marginBottom: '10px' } },
              '核心安全门 (leaderteam-core) 始终保护工具执行；其余功能插件均可独立拆卸而不会拖垮普通会话或剩余功能。'
            ),
            PLUGIN_META.map(pm => {
              const active = Boolean(data && data.activePlugins && data.activePlugins[pm.key]);
              const cfgVal = !(data && data.configSnapshot && data.configSnapshot.plugins && data.configSnapshot.plugins[pm.key] === false);
              return h(
                'div',
                { key: pm.key, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid rgba(128,128,128,0.15)', gap: '8px' } },
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: '13px' } }, pm.label + (active ? ' [运行中]' : ' [已拆卸]')),
                  h('div', { style: { fontSize: '11px', opacity: 0.75 } }, pm.desc)
                ),
                h('button', { style: btnStyle(cfgVal), onClick: () => onTogglePlugin(pm.key, !cfgVal), disabled: loading }, cfgVal ? '已启用（点击拆卸）' : '已停用（点击启用）')
              );
            })
          ),
          h('div', { style: cardStyle },
            h('strong', null, '长跑护栏与隐私安全开关（实时热重载）'),
            (() => {
              const pmEnabled = !(data && data.configSnapshot && data.configSnapshot.powerMonitor && data.configSnapshot.powerMonitor.enabled === false);
              return h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', marginTop: '6px', borderTop: '1px solid rgba(128,128,128,0.15)', gap: '8px' } },
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: '13px' } }, '电池感知式安全收尾 (powerMonitor.enabled)' + (pmEnabled ? ' [已启用]' : ' [已关闭]')),
                  h('div', { style: { fontSize: '11px', opacity: 0.75 } }, '默认每 12 分钟无窗口静默读取 (onBattery, batteryPct) 两个数值（绝不采集任何硬件序列号；Linux VPS / WSL2 自动静默跳过）。电池供电 <=20% 时单次通知领队落盘检查点；接电恢复绝不擅自重启已暂停工程。')
                ),
                h('button', { style: btnStyle(pmEnabled), onClick: () => onTogglePowerMonitor(!pmEnabled), disabled: loading }, pmEnabled ? '已启用（点击关闭）' : '已关闭（点击启用）')
              );
            })()
          )
        ) : null,

        // TAB 3: Engineering Timers
        tab === 'timers' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('strong', null, '项目与任务工程计时器（评审团决策强制参考指标）'),
            (data && Array.isArray(data.timers) && data.timers.length > 0)
              ? data.timers.map(tm => h(
                'div',
                { key: tm.teamId, style: { padding: '8px 0', borderTop: '1px solid rgba(128,128,128,0.15)', marginTop: '8px', fontSize: '12px' } },
                h('div', { style: { fontWeight: 600 } },
                  '会话 ' + tm.teamId + ' · 时间压力: ' + tm.time_pressure.toUpperCase() + (tm.stagnation_fallback_eligible ? ' [已触发防停滞择优条件]' : '')
                ),
                h('div', { style: { opacity: 0.8 } }, '工作区: ' + (tm.workspace || '(未绑定)')),
                h('div', null,
                  '项目总跨度: ' + formatMs(tm.project_wall_ms) +
                  ' | 累计活跃: ' + formatMs(tm.project_active_ms) +
                  ' | 当前任务 (#' + tm.task_seq + '): ' + formatMs(tm.task_wall_ms) +
                  ' | 规划停滞: ' + formatMs(tm.planning_stagnation_ms) +
                  ' | 未通过规划轮次: ' + tm.unapproved_plan_attempts
                )
              ))
              : h('div', { style: { marginTop: '8px', opacity: 0.7, fontSize: '12px' } }, '暂无活跃团队计时记录。启动一次 LeaderTeam 会话后将自动持久化记录。')
          )
        ) : null,

        // TAB 4: Plan Archive, Retrospectives & Cleanup
        tab === 'archive' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: { fontWeight: 600 } }, '固定外部计划归档目录（严禁写入项目工作区内）'),
            h('div', { style: { fontSize: '11px', fontFamily: 'monospace', marginTop: '4px', wordBreak: 'break-all' } },
              (data && data.archive && data.archive.root) ? data.archive.root : '(归档未启用)'
            ),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } },
              h('select', { style: inputStyle, value: catFilter, onChange: e => onFilterArchive(e.target.value, stateFilter) },
                h('option', { value: '' }, '全部分类'),
                ((data && data.archive && data.archive.categories) || []).map(c => h('option', { key: c, value: c }, c))
              ),
              h('select', { style: inputStyle, value: stateFilter, onChange: e => onFilterArchive(catFilter, e.target.value) },
                h('option', { value: '' }, '全部状态'),
                ((data && data.archive && data.archive.lifecycleStates) || []).map(s => h('option', { key: s, value: s }, s))
              ),
              h('input', { style: { ...inputStyle, width: '110px' }, placeholder: '清理早于 N 天', value: cleanDays, onChange: e => setCleanDays(e.target.value) }),
              h('button', { style: btnStyle(false), onClick: () => onCleanArchive(false), disabled: loading }, '预览清理'),
              h('button', { style: btnStyle(false), onClick: () => onCleanArchive(true), disabled: loading }, '确认清理外部归档')
            ),
            cleanPreview ? h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: 0.85 } },
              (cleanPreview.dryRun ? '[预览] 将匹配清理 ' + cleanPreview.matchedCount + ' 条计划。' : '已清理 ' + cleanPreview.removedCount + ' 条计划。')
            ) : null
          ),
          h('div', { style: cardStyle },
            h('strong', null, '归档计划列表（点击查看评审建议或生成执行后复审）'),
            archivePlans.length === 0
              ? h('div', { style: { marginTop: '8px', opacity: 0.7, fontSize: '12px' } }, '当前筛选条件下无归档计划。')
              : archivePlans.map(p => h(
                'div',
                {
                  key: p.planId,
                  onClick: () => onSelectPlan(p.planId),
                  style: { padding: '8px', borderTop: '1px solid rgba(128,128,128,0.15)', cursor: 'pointer', fontSize: '12px' },
                },
                h('div', { style: { fontWeight: 600 } }, '[' + p.category + '] ' + p.topic + ' (' + p.lifecycleState + ')'),
                h('div', { style: { opacity: 0.75, fontSize: '11px' } },
                  'ID: ' + p.planId + ' · 项目: ' + (p.projectLabel || p.projectKey) + ' · 复审数: ' + (p.retrospectiveCount || 0)
                )
              ))
          ),
          selectedPlan ? h('div', { style: cardStyle },
            h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '计划详情与执行后复审：' + selectedPlan.topic),
            h('div', { style: { fontSize: '11px', opacity: 0.8, marginBottom: '6px' } },
              '分类: ' + selectedPlan.category + ' | 状态: ' + selectedPlan.lifecycleState + ' | 协议ID: ' + selectedPlan.agreementId
            ),
            selectedPlan.outcome ? h('div', { style: { marginBottom: '8px', fontSize: '12px' } },
              h('div', null, '评审结论: ' + selectedPlan.outcome.decision + ' (by ' + selectedPlan.outcome.by + ')'),
              (selectedPlan.outcome.reasons && selectedPlan.outcome.reasons.length > 0)
                ? h('div', null, '理由: ' + selectedPlan.outcome.reasons.join('；'))
                : null,
              (selectedPlan.outcome.suggestions && selectedPlan.outcome.suggestions.length > 0)
                ? h('div', null, '建议方案: ' + selectedPlan.outcome.suggestions.join('；'))
                : null
            ) : null,
            h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '180px', overflowY: 'auto', padding: '8px', background: 'rgba(128,128,128,0.08)', borderRadius: '6px', fontSize: '11px' } }, selectedPlan.proposal),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', { style: { ...inputStyle, flex: 1, minWidth: '180px' }, placeholder: '可选：补充复审备注（如某环节返工原因）', value: retroNotes, onChange: e => setRetroNotes(e.target.value) }),
              h('button', { style: btnStyle(true), onClick: () => onRunRetrospect(selectedPlan.planId), disabled: loading }, '生成执行后复审')
            ),
            (Array.isArray(selectedPlan.retrospectives) && selectedPlan.retrospectives.length > 0)
              ? selectedPlan.retrospectives.map(r => h(
                'div',
                { key: r.retroId, style: { marginTop: '8px', padding: '8px', borderRadius: '6px', background: 'rgba(37,99,235,0.08)', fontSize: '12px' } },
                h('div', { style: { fontWeight: 600 } }, '复审 ' + r.retroId + ' · 总结: ' + r.verdict),
                (r.findings || []).map((f, idx) => h('div', { key: idx }, '• [' + f.stage + '/' + f.severity + '] ' + f.detail))
              ))
              : null
          ) : null
        ) : null,

        // TAB 6: Auto-Update, Rollback, Host Compatibility & Quick Onboarding
        tab === 'updates' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' } },
              h('strong', null, '版本更新、一键升级与宿主兼容性'),
              h('button', {
                style: btnStyle(true),
                disabled: loading,
                onClick: async () => {
                  setLoading(true); setError(null); setNotice(null);
                  try {
                    const res = await postApi(ROUTES.UPDATE, { action: 'check', force: true });
                    setUpdateCheckInfo(res.check);
                    setNotice(res.check && res.check.hasUpdate ? ('发现新版本 v' + res.check.latestRelease.version + '！') : '当前已是该发行分支最新版本。');
                  } catch (e) { setError(e && e.message ? e.message : String(e)); }
                  finally { setLoading(false); }
                },
              }, loading ? '检查中…' : '立即检查更新')
            ),
            h('div', { style: { fontSize: '12px', marginBottom: '8px' } },
              '当前版本：v' + ((data && data.updater && data.updater.installed && data.updater.installed.version) || '2.2.x') +
              ' · 分支：' + ((data && data.updater && data.updater.installed && data.updater.installed.trackInfo && data.updater.installed.trackInfo.label) || '开源版') +
              (data && data.hostCompatibility ? (' · DSH 宿主：' + (data.hostCompatibility.toolsVersion || '') + ' (' + data.hostCompatibility.classification + ')') : '')
            ),
            (updateCheckInfo && updateCheckInfo.hasUpdate && updateCheckInfo.latestRelease)
              ? h('div', { style: { padding: '10px', borderRadius: '6px', background: tok.infoBg, marginBottom: '8px', fontSize: '12px' } },
                  h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, '可用更新：v' + updateCheckInfo.latestRelease.version + ' (' + updateCheckInfo.latestRelease.tagName + ')'),
                  h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '140px', overflowY: 'auto', fontSize: '11px', margin: '6px 0' } }, updateCheckInfo.latestRelease.body || '无详细说明'),
                  h('button', {
                    style: btnStyle(true),
                    disabled: loading,
                    onClick: async () => {
                      setLoading(true); setError(null); setNotice('正在下载、校验 SHA-256、备份并升级…');
                      try {
                        const res = await postApi(ROUTES.UPDATE, { action: 'apply' });
                        setNotice((res.result && res.result.message) || '已完成一键升级！');
                        setTimeout(() => loadState({}), 2500);
                      } catch (e) { setError(e && e.message ? e.message : String(e)); }
                      finally { setLoading(false); }
                    },
                  }, '一键下载、校验并安装升级')
                )
              : null,
            (data && data.updater && Array.isArray(data.updater.backups) && data.updater.backups.length > 0)
              ? h('div', { style: { marginTop: '8px', fontSize: '12px' } },
                  h('strong', null, '本地回滚快照：'),
                  data.updater.backups.map(b => h('div', { key: b.backupId, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' } },
                    h('span', null, 'v' + b.fromVersion + ' → v' + b.toVersion),
                    h('button', {
                      style: btnStyle(false),
                      disabled: loading,
                      onClick: async () => {
                        setLoading(true); setError(null);
                        try {
                          const res = await postApi(ROUTES.UPDATE, { action: 'rollback', backupId: b.backupId });
                          setNotice((res.result && res.result.message) || '已执行回滚');
                        } catch (e) { setError(e && e.message ? e.message : String(e)); }
                        finally { setLoading(false); }
                      },
                    }, '一键回滚至 v' + b.fromVersion)
                  ))
                )
              : null
          ),
          h('div', { style: cardStyle },
            h('strong', { style: { display: 'block', marginBottom: '6px' } }, '新手零命令行快速模型接入'),
            h('div', { style: { fontSize: '11.5px', color: tok.fgMuted, marginBottom: '8px' } }, '直接选择厂商并粘贴 API Key，自动写入本地凭据库并生成全套团队角色路由，无需配置环境变量。'),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
              h('select', { style: inputStyle, value: quickProvider, onChange: e => setQuickProvider(e.target.value) },
                h('option', { value: 'deepseek' }, 'DeepSeek'),
                h('option', { value: 'dashscope' }, '阿里云百炼 (Qwen)'),
                h('option', { value: 'zhipu' }, '智谱 (GLM)'),
                h('option', { value: 'openai' }, 'OpenAI'),
                h('option', { value: 'openai-compatible' }, 'OpenAI 兼容接口')
              ),
              h('input', { type: 'password', style: { ...inputStyle, flex: 1, minWidth: '160px' }, placeholder: '粘贴 API Key (sk-...)', value: quickApiKey, onChange: e => setQuickApiKey(e.target.value) }),
              h('button', {
                style: btnStyle(true),
                disabled: loading || !quickApiKey.trim(),
                onClick: async () => {
                  setLoading(true); setError(null);
                  try {
                    await postApi(ROUTES.ONBOARDING, { action: 'apply-quick-setup', providerId: quickProvider, apiKey: quickApiKey.trim() });
                    setQuickApiKey('');
                    setNotice('已完成快速模型接入与团队角色配置！新建会话选择 LeaderTeam 预设即可开始。');
                    await loadState({});
                  } catch (e) { setError(e && e.message ? e.message : String(e)); }
                  finally { setLoading(false); }
                },
              }, '一键保存并配置团队')
            )
          )
        ) : null
      );
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) return;
      try {
        activeHostConnection = ctx.connection || (typeof ctx.get === 'function' ? ctx.get('connection') : null) || null;
      } catch {}
      ctx.effect(() => {
        const disposers = [];
        const own = d => { if (typeof d === 'function') disposers.push(d); };
        try {
          own(ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            props => h(ConsoleView, props)
          )));
          own(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => 'LeaderTeam' },
            props => h(PanelIcon, { size: props && typeof props.size === 'number' ? props.size : 18 })
          )));
        } catch {}
        return () => { for (const d of disposers) { try { d(); } catch {} } };
      }, 'leaderteam-panel: main page');

      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], injected => {
          const disposers = [];
          const own = d => { if (typeof d === 'function') disposers.push(d); };
          try {
            const tabs = injected.sidebarRightTabs;
            if (!tabs || typeof tabs.register !== 'function') return;
            own(tabs.register({
              id: PANEL_ID,
              kind: PANEL_ID,
              title: () => 'LeaderTeam',
              guide: [{
                id: PANEL_ID,
                order: PANEL_ORDER,
                title: () => 'LeaderTeam 控制台',
                description: () => '管理上游动态模型、可拆卸插件、工程计时与外部计划归档',
                icon: PanelIcon,
              }],
            }));
            own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
              { name: 'sidebar.right.pane.tab', key: PANEL_ID },
              props => h(ConsoleView, Object.assign({}, props, { host: 'sidebar' }))
            )));
            own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: PANEL_ID },
              TabTitle
            )));
          } catch {
            for (const d of disposers) { try { d(); } catch {} }
            return undefined;
          }
          return () => { for (const d of disposers) { try { d(); } catch {} } };
        });
      }
    }

    return {
      name: PANEL_ID,
      inject: ['slots'],
      apply,
      ConsoleView,
    };
  }

  const descriptor = { id: PANEL_ID, factory: createLeaderTeamPanelClient };
  if (typeof globalThis !== 'undefined') {
    globalThis.__LEADERTEAM_PANEL_CLIENT__ = descriptor;
  }
  if (typeof window !== 'undefined' && window && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: 'dsh-leaderteam', factory: createLeaderTeamPanelClient });
    window.__ModuleLoader__.load({ id: 'dsh-leaderteam/client', factory: createLeaderTeamPanelClient });
    window.__ModuleLoader__.load(descriptor);
  }
})();
