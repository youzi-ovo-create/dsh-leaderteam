import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyThemeToDom,
  callLtApi,
  computeTodayUsageSummary,
  type HydratedBundle,
} from './lib/api';
import {
  DEFAULT_CUSTOM_SEEDS,
  readStoredAppearance,
  type DensityMode,
  type DisplayFontMode,
} from './lib/theme';
import { HeluoxuMark } from './components/HeluoxuMark';
import { Icon, type IconName } from './components/Icon';
import {
  Rail,
  StatusBar,
  restoreSavedPaneWidths,
  type NavItemDef,
  type NavViewId,
} from './components/AppShell';
import {
  AnchoredPopover,
  CommandPalette,
  ToastHost,
  type PaletteCommand,
  type ToastItem,
} from './components/Overlays';
import { WorkbenchView } from './views/WorkbenchView';
import { TeamsView } from './views/TeamsView';
import { ConnectView } from './views/ConnectView';
import { HengzhangView } from './views/HengzhangView';
import { SettingsView } from './views/SettingsView';
import type { CustomThemeSeeds, ThemePresetId } from './types/lt-public-v1';

interface ParsedRoute {
  view: NavViewId;
  sub: string | null;
  sessionParam: string | null;
}

function parseLocationRoute(): ParsedRoute {
  if (typeof window === 'undefined') {
    return { view: 'workbench', sub: null, sessionParam: null };
  }
  const searchParams = new URLSearchParams(window.location.search || '');
  const rawHash = (window.location.hash || '').replace(/^#\/?/, '');
  const [pathPart, hashQuery] = rawHash.split('?');
  const hashParams = new URLSearchParams(hashQuery || '');
  const sessionParam = hashParams.get('session') || searchParams.get('session') || null;
  const segs = pathPart.split('/').filter(Boolean);
  const rawView = segs[0] || 'workbench';
  const validViews: NavViewId[] = ['workbench', 'teams', 'connect', 'hengzhang', 'settings'];
  const view: NavViewId = validViews.includes(rawView as NavViewId)
    ? (rawView as NavViewId)
    : rawView === 'governance'
      ? 'teams'
      : rawView === 'providers' || rawView === 'models'
        ? 'connect'
        : rawView === 'system'
          ? 'settings'
          : 'workbench';
  const sub =
    segs[1] ||
    (rawView === 'providers' ? 'providers' : rawView === 'models' ? 'models' : null);
  return { view, sub, sessionParam };
}

function writeHashRoute(view: NavViewId, sub?: string | null, sessionId?: string | null) {
  if (typeof window === 'undefined') return;
  const base = `#/${view}${sub ? `/${sub}` : ''}`;
  const full = sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base;
  if (window.location.hash !== full) {
    window.location.hash = full;
  }
}

export function App() {
  const storedUi = useMemo(() => readStoredAppearance(), []);
  const [bundle, setBundle] = useState<HydratedBundle | null>(null);
  const [route, setRoute] = useState<ParsedRoute>(() => parseLocationRoute());
  const [theme, setTheme] = useState<ThemePresetId>('white');
  const [customTheme, setCustomTheme] = useState<CustomThemeSeeds>(DEFAULT_CUSTOM_SEEDS);
  const [density, setDensity] = useState<DensityMode>(storedUi.density);
  const [display, setDisplay] = useState<DisplayFontMode>(storedUi.display);
  const [ctxOpen, setCtxOpen] = useState(true);
  const [insOpen, setInsOpen] = useState(true);
  const [hasRunningSession, setHasRunningSession] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string>(route.sessionParam || '');
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const [todayUsage, setTodayUsage] = useState<{ costCny: number | null; unknownCount: number }>({
    costCny: null,
    unknownCount: 0,
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themeMenuAnchor, setThemeMenuAnchor] = useState<DOMRect | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const previewingUnsavedThemeRef = useRef(false);
  const densityRef = useRef(density);
  densityRef.current = density;
  const displayRef = useRef(display);
  displayRef.current = display;

  const pushToast = useCallback((message: string, icon: IconName = 'info') => {
    const id = `t-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    setToasts(prev => [...prev.slice(-3), { id, message, icon }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2800);
  }, []);

  const refreshBundle = useCallback(async () => {
    try {
      const data = await callLtApi<HydratedBundle>('bundle');
      setBundle(data);
      setLoadError(null);
      if (data.uiPreferences && !previewingUnsavedThemeRef.current) {
        const nextTheme = data.uiPreferences.theme || 'white';
        const nextCustom = data.uiPreferences.customTheme || DEFAULT_CUSTOM_SEEDS;
        setTheme(nextTheme);
        setCustomTheme(nextCustom);
        applyThemeToDom(nextTheme, nextCustom, {
          density: densityRef.current,
          display: displayRef.current,
        });
      }
      if (data.capabilities?.features?.usageAnalytics && data.usageStatus?.enabled) {
        callLtApi<any>('usage/overview', { syncGateway: false })
          .then(ovRes => {
            if (ovRes?.overview) {
              setTodayUsage(computeTodayUsageSummary(ovRes.overview));
            }
          })
          .catch(() => {});
      } else {
        setTodayUsage({ costCny: null, unknownCount: 0 });
      }
    } catch (e: any) {
      setLoadError(e.message || '加载工作台状态失败');
    }
  }, []);

  useEffect(() => {
    restoreSavedPaneWidths();
    void refreshBundle();
  }, [refreshBundle]);

  useEffect(() => {
    const onHash = () => {
      const parsed = parseLocationRoute();
      setRoute(parsed);
      if (parsed.sessionParam) setActiveSessionId(parsed.sessionParam);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const handleDraftChange = useCallback((sessionId: string, text: string) => {
    if (!sessionId) return;
    setDraftsBySession(prev => {
      if ((prev[sessionId] || '') === text) return prev;
      if (!text) {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      }
      return { ...prev, [sessionId]: text };
    });
  }, []);

  const navigateTo = useCallback((view: NavViewId, sub?: string | null, sessionId?: string | null) => {
    setRoute({ view, sub: sub ?? null, sessionParam: sessionId ?? null });
    if (sessionId) setActiveSessionId(sessionId);
    writeHashRoute(view, sub, sessionId);
  }, []);

  const handleLegacyTabNavigate = useCallback(
    (tab: string) => {
      if (tab === 'governance' || tab === 'teams') navigateTo('teams');
      else if (tab === 'providers') navigateTo('connect', 'providers');
      else if (tab === 'models') navigateTo('connect', 'models');
      else if (tab === 'hengzhang') navigateTo('hengzhang');
      else if (tab === 'system' || tab === 'settings') navigateTo('settings', 'appearance');
      else navigateTo('workbench');
    },
    [navigateTo],
  );

  const handlePreviewTheme = useCallback((nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) => {
    previewingUnsavedThemeRef.current = true;
    setTheme(nextTheme);
    setCustomTheme(nextSeeds);
    applyThemeToDom(nextTheme, nextSeeds, {
      density: densityRef.current,
      display: displayRef.current,
    });
  }, []);

  const handleThemeChange = useCallback(async (nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) => {
    previewingUnsavedThemeRef.current = false;
    setTheme(nextTheme);
    setCustomTheme(nextSeeds);
    applyThemeToDom(nextTheme, nextSeeds, {
      density: densityRef.current,
      display: displayRef.current,
    });
    await callLtApi('ui-preferences', { theme: nextTheme, customTheme: nextSeeds });
  }, []);

  const handleDensityChange = useCallback(
    (nextDensity: DensityMode) => {
      setDensity(nextDensity);
      densityRef.current = nextDensity;
      const nextCustom: CustomThemeSeeds = {
        ...customTheme,
        density: nextDensity,
      };
      setCustomTheme(nextCustom);
      applyThemeToDom(theme, nextCustom, { density: nextDensity, display: displayRef.current });
    },
    [theme, customTheme],
  );

  const handleDisplayChange = useCallback(
    (nextDisplay: DisplayFontMode) => {
      setDisplay(nextDisplay);
      displayRef.current = nextDisplay;
      const nextCustom: CustomThemeSeeds = {
        ...customTheme,
        headingFontMode: nextDisplay,
      };
      setCustomTheme(nextCustom);
      applyThemeToDom(theme, nextCustom, { density: densityRef.current, display: nextDisplay });
    },
    [theme, customTheme],
  );

  const feats = bundle?.capabilities.features;
  const navItems: NavItemDef[] = useMemo(
    () => [
      { id: 'workbench', label: '工作台', icon: 'chat', shortcut: '1', visible: true },
      { id: 'teams', label: '团队', icon: 'network', shortcut: '2', visible: Boolean(feats?.teamObservability) },
      {
        id: 'connect',
        label: '接入',
        icon: 'plug',
        shortcut: '3',
        visible: Boolean(
          feats?.magpieGateway || feats?.directProviders || feats?.modelPoolWrite || feats?.roleConfigWrite,
        ),
      },
      { id: 'hengzhang', label: '衡账', icon: 'ledger', shortcut: '4', visible: Boolean(feats?.usageAnalytics) },
      { id: 'settings', label: '设置', icon: 'sliders', shortcut: '9', visible: true },
    ],
    [feats],
  );

  // Global keyboard shortcuts (Ctrl+K, Ctrl+B, Ctrl+., Ctrl+1..4, Ctrl+9, Esc)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCtxOpen(v => !v);
      } else if (mod && e.key === '.') {
        e.preventDefault();
        setInsOpen(v => !v);
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const hit = navItems.find(n => n.visible && n.shortcut === e.key);
        if (hit) {
          e.preventDefault();
          navigateTo(hit.id);
        }
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
        setThemeMenuAnchor(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navItems, navigateTo]);

  const dshFrontendUrl = useMemo(() => {
    if (!bundle?.capabilities.frontendSwitch.available) return null;
    const base = bundle.capabilities.frontendSwitch.dshFrontendUrl;
    if (!base) return null;
    if (!activeSessionId) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}session=${encodeURIComponent(activeSessionId)}`;
  }, [bundle, activeSessionId]);

  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const navCmds: PaletteCommand[] = navItems
      .filter(n => n.visible)
      .map(n => ({
        id: `nav-${n.id}`,
        group: '前往',
        label: n.label,
        icon: n.icon,
        hint: `Ctrl+${n.shortcut}`,
        run: () => navigateTo(n.id),
      }));

    const connectCmds: PaletteCommand[] =
      feats?.magpieGateway || feats?.directProviders
        ? [
            {
              id: 'conn-gw',
              group: '接入',
              label: '管理 Magpie 网关',
              icon: 'cpu',
              run: () => navigateTo('connect', 'gateway'),
            },
            {
              id: 'conn-prov',
              group: '接入',
              label: '管理供应商与凭据池',
              icon: 'key',
              run: () => navigateTo('connect', 'providers'),
            },
            {
              id: 'conn-models',
              group: '接入',
              label: '模型目录与执行池',
              icon: 'layers',
              run: () => navigateTo('connect', 'models'),
            },
            {
              id: 'conn-roles',
              group: '接入',
              label: '角色路由与故障回退链',
              icon: 'route',
              run: () => navigateTo('connect', 'roles'),
            },
          ]
        : [];

    const switchThemeSafe = (nextTheme: ThemePresetId) => {
      void handleThemeChange(nextTheme, customTheme).catch(err => {
        pushToast(
          `主题服务端保存失败（仅更新本地预览）：${err?.message || '请求失败'}`,
          'alert',
        );
      });
    };

    const themeCmds: PaletteCommand[] = [
      {
        id: 'th-white',
        group: '外观',
        label: '主题：白色（日光工程白）',
        icon: 'sun',
        keywords: 'theme white',
        run: () => switchThemeSafe('white'),
      },
      {
        id: 'th-dark',
        group: '外观',
        label: '主题：黑色（深碳石板）',
        icon: 'moon',
        keywords: 'theme dark',
        run: () => switchThemeSafe('dark'),
      },
      {
        id: 'th-heluoxu',
        group: '外观',
        label: '主题：河洛序（宣纸焦铜）',
        icon: 'doc',
        keywords: 'theme heluoxu',
        run: () => switchThemeSafe('heluoxu'),
      },
      {
        id: 'th-custom',
        group: '外观',
        label: '主题：自定义（种子色推导）',
        icon: 'contrast',
        keywords: 'theme custom',
        run: () => switchThemeSafe('custom'),
      },
      {
        id: 'th-density',
        group: '外观',
        label: `切换信息密度（当前：${density === 'compact' ? '紧凑' : '舒适'}）`,
        icon: 'sliders',
        run: () => handleDensityChange(density === 'compact' ? 'comfortable' : 'compact'),
      },
    ];

    const layoutCmds: PaletteCommand[] = [
      {
        id: 'ly-ctx',
        group: '布局',
        label: '收起 / 展开左侧上下文栏',
        icon: 'panelL',
        hint: 'Ctrl+B',
        run: () => setCtxOpen(v => !v),
      },
      {
        id: 'ly-ins',
        group: '布局',
        label: '收起 / 展开右侧检视栏',
        icon: 'panelR',
        hint: 'Ctrl+.',
        run: () => setInsOpen(v => !v),
      },
    ];

    if (dshFrontendUrl) {
      layoutCmds.unshift({
        id: 'to-dsh',
        group: '会话',
        label: '在 DSH 原生前端打开当前会话',
        icon: 'swap',
        run: () => {
          window.location.href = dshFrontendUrl;
        },
      });
    }

    return [...navCmds, ...connectCmds, ...themeCmds, ...layoutCmds];
  }, [navItems, feats, navigateTo, handleThemeChange, customTheme, density, handleDensityChange, dshFrontendUrl, pushToast]);

  /* ==================== ERROR / LOADING SHELL ==================== */
  if (loadError && !bundle) {
    return (
      <div className="app">
        <nav className="rail">
          <div className="rail-brand">
            <HeluoxuMark size={24} />
          </div>
        </nav>
        <div className="body">
          <main className="stage">
            <div className="empty" style={{ height: '80%' }}>
              <HeluoxuMark size={36} />
              <h3>无法连接本地 Leader Team 服务</h3>
              <p className="t-small" style={{ maxWidth: 460, margin: 0 }}>
                {loadError}
              </p>
              <button type="button" className="btn btn-primary" onClick={() => void refreshBundle()}>
                <Icon name="refresh" className="icon-14" />
                重新连接
              </button>
            </div>
          </main>
        </div>
        <footer className="status">
          <span className="status-item">
            <i className="dot err" />
            连接失败
          </span>
        </footer>
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="app">
        <nav className="rail">
          <div className="rail-brand">
            <HeluoxuMark size={24} />
          </div>
        </nav>
        <div className="body">
          <aside className="pane pane-context" style={{ padding: 16, gap: 10 }}>
            <div className="skeleton-block" style={{ height: 28, width: '70%' }} />
            <div className="skeleton-block" style={{ height: 48, width: '100%' }} />
            <div className="skeleton-block" style={{ height: 48, width: '100%' }} />
            <div className="skeleton-block" style={{ height: 48, width: '85%' }} />
          </aside>
          <main className="stage" style={{ padding: 28, gap: 16 }}>
            <div className="skeleton-block" style={{ height: 24, width: 220 }} />
            <div className="skeleton-block" style={{ height: 90, maxWidth: 720 }} />
            <div className="skeleton-block" style={{ height: 120, maxWidth: 720 }} />
          </main>
        </div>
        <footer className="status">
          <span className="status-item">
            <i className="dot idle" />
            正在载入 Leader Team 工程工作台…
          </span>
        </footer>
      </div>
    );
  }

  const hasEscalation = (bundle.runtime.teams || []).some(t => t.status === 'waiting_user');
  const activeView: NavViewId = navItems.some(n => n.id === route.view && n.visible)
    ? route.view
    : 'workbench';

  return (
    <div className="app">
      <Rail
        items={navItems}
        activeView={activeView}
        hasRunningSession={hasRunningSession}
        hasEscalation={hasEscalation}
        dshFrontendUrl={dshFrontendUrl}
        onNavigate={(v, sub) => navigateTo(v, sub)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenThemeMenu={rect => setThemeMenuAnchor(prev => (prev ? null : rect))}
      />

      {activeView === 'workbench' && (
        <WorkbenchView
          bundle={bundle}
          initialSessionId={route.sessionParam || activeSessionId || undefined}
          ctxOpen={ctxOpen}
          insOpen={insOpen}
          onToggleCtx={() => setCtxOpen(v => !v)}
          onToggleIns={() => setInsOpen(v => !v)}
          onRefreshBundle={refreshBundle}
          onNavigateTab={handleLegacyTabNavigate}
          onNotify={pushToast}
          onRunningChange={setHasRunningSession}
          onSessionSelected={setActiveSessionId}
          draftsBySession={draftsBySession}
          onDraftChange={handleDraftChange}
        />
      )}

      {activeView === 'teams' && (
        <TeamsView
          bundle={bundle}
          initialSub={route.sub}
          ctxOpen={ctxOpen}
          onToggleCtx={() => setCtxOpen(v => !v)}
          onRefreshBundle={refreshBundle}
          onOpenSession={sid => navigateTo('workbench', null, sid)}
          onNavigateSub={sub => navigateTo('teams', sub)}
          onNotify={pushToast}
        />
      )}

      {activeView === 'connect' && (
        <ConnectView
          bundle={bundle}
          initialSub={route.sub}
          ctxOpen={ctxOpen}
          onToggleCtx={() => setCtxOpen(v => !v)}
          onRefreshBundle={refreshBundle}
          onNavigateSub={sub => navigateTo('connect', sub)}
          onNotify={pushToast}
        />
      )}

      {activeView === 'hengzhang' && (
        <HengzhangView
          bundle={bundle}
          onRefreshBundle={refreshBundle}
          onNotify={pushToast}
          onUsageSummary={setTodayUsage}
        />
      )}

      {activeView === 'settings' && (
        <SettingsView
          bundle={bundle}
          theme={theme}
          customTheme={customTheme}
          density={density}
          display={display}
          initialSub={route.sub}
          ctxOpen={ctxOpen}
          onToggleCtx={() => setCtxOpen(v => !v)}
          onPreviewTheme={handlePreviewTheme}
          onChangeTheme={handleThemeChange}
          onChangeDensity={handleDensityChange}
          onChangeDisplay={handleDisplayChange}
          onNavigateSub={sub => navigateTo('settings', sub)}
          onRefreshBundle={refreshBundle}
          onNotify={pushToast}
        />
      )}

      <StatusBar
        bundle={bundle}
        todayCostCny={todayUsage.costCny}
        todayUnknownCount={todayUsage.unknownCount}
        onNavigate={(v, sub) => navigateTo(v, sub)}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {/* Quick Theme & Density Popover from Rail */}
      <AnchoredPopover
        open={Boolean(themeMenuAnchor)}
        anchorRect={themeMenuAnchor}
        placement="right-up"
        onClose={() => setThemeMenuAnchor(null)}
      >
        <div className="t-overline" style={{ padding: '6px 9px 4px' }}>
          主题
        </div>
        {(
          [
            ['white', '白色 · 日光工程白', 'sun'],
            ['dark', '黑色 · 深碳石板', 'moon'],
            ['heluoxu', '河洛序 · 宣纸焦铜', 'doc'],
            ['custom', '自定义 · 种子色推导', 'contrast'],
          ] as Array<[ThemePresetId, string, IconName]>
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className="menu-item"
            onClick={() => {
              setThemeMenuAnchor(null);
              void handleThemeChange(id, customTheme).catch(err => {
                pushToast(
                  `主题服务端保存失败（仅更新本地预览）：${err?.message || '请求失败'}`,
                  'alert',
                );
              });
            }}
          >
            <Icon name={icon} />
            <span>{label}</span>
            {theme === id && (
              <span className="muted">
                <Icon name="check" className="icon-14" />
              </span>
            )}
          </button>
        ))}
        <div className="menu-sep" />
        <div className="t-overline" style={{ padding: '6px 9px 4px' }}>
          密度
        </div>
        <div style={{ padding: '2px 6px 6px' }}>
          <div className="seg seg-sm">
            <button
              type="button"
              aria-pressed={density === 'comfortable'}
              onClick={() => {
                handleDensityChange('comfortable');
                setThemeMenuAnchor(null);
              }}
            >
              舒适
            </button>
            <button
              type="button"
              aria-pressed={density === 'compact'}
              onClick={() => {
                handleDensityChange('compact');
                setThemeMenuAnchor(null);
              }}
            >
              紧凑
            </button>
          </div>
        </div>
        <div className="menu-sep" />
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            setThemeMenuAnchor(null);
            navigateTo('settings', 'appearance');
          }}
        >
          <Icon name="sliders" />
          <span>外观设置与主题编辑器…</span>
        </button>
      </AnchoredPopover>

      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
      />

      <ToastHost toasts={toasts} />
    </div>
  );
}
