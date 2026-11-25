import React, { useCallback, useEffect, useState } from 'react';
import { HeluoxuMark } from './components/HeluoxuMark';
import { applyThemeToDom, callLtApi, type HydratedBundle } from './lib/api';
import { WorkbenchView } from './views/WorkbenchView';
import { GovernanceView } from './views/GovernanceView';
import { ProvidersView } from './views/ProvidersView';
import { ModelsRolesView } from './views/ModelsRolesView';
import { HengzhangView } from './views/HengzhangView';
import { SystemAppearanceView } from './views/SystemAppearanceView';
import type { CustomThemeSeeds, ThemePresetId } from './types/lt-public-v1';

const DEFAULT_SEEDS: CustomThemeSeeds = {
  canvasColor: '#F7F8FA',
  surfaceColor: '#FFFFFF',
  inkColor: '#141619',
  accentColor: '#9C5B2E',
  dangerColor: '#A3263F',
  headingFontMode: 'serif',
  cornerStyle: 'balanced',
  density: 'standard',
};

export function App() {
  const [bundle, setBundle] = useState<HydratedBundle | null>(null);
  const [activeTab, setActiveTab] = useState<string>('workbench');
  const [theme, setTheme] = useState<ThemePresetId>('white');
  const [customTheme, setCustomTheme] = useState<CustomThemeSeeds>(DEFAULT_SEEDS);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshBundle = useCallback(async () => {
    try {
      const data = await callLtApi<HydratedBundle>('bundle');
      setBundle(data);
      setLoadError(null);
      if (data.uiPreferences) {
        setTheme(data.uiPreferences.theme || 'white');
        setCustomTheme(data.uiPreferences.customTheme || DEFAULT_SEEDS);
        applyThemeToDom(data.uiPreferences.theme || 'white', data.uiPreferences.customTheme || DEFAULT_SEEDS);
      }
    } catch (e: any) {
      setLoadError(e.message || '加载工作台状态失败');
    }
  }, []);

  useEffect(() => {
    void refreshBundle();
  }, [refreshBundle]);

  async function handleThemeChange(nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) {
    setTheme(nextTheme);
    setCustomTheme(nextSeeds);
    applyThemeToDom(nextTheme, nextSeeds);
    try {
      await callLtApi('ui-preferences', { theme: nextTheme, customTheme: nextSeeds });
    } catch {}
  }

  if (loadError && !bundle) {
    return (
      <div className="lt-app">
        <header className="lt-header">
          <div className="lt-brand">
            <HeluoxuMark />
            <span className="lt-brand-title">Leader Team</span>
          </div>
        </header>
        <main className="lt-main">
          <div className="lt-banner lt-banner-danger">
            <span>连接本地服务失败：{loadError}</span>
            <button className="lt-btn lt-btn-sm" onClick={() => void refreshBundle()}>重试</button>
          </div>
        </main>
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="lt-app">
        <header className="lt-header">
          <div className="lt-brand">
            <HeluoxuMark />
            <span className="lt-brand-title">Leader Team</span>
          </div>
        </header>
        <main className="lt-main">
          <div style={{ padding: '48px 0', color: 'var(--lt-fg-muted)' }}>正在加载 Leader Team 工程工作台…</div>
        </main>
      </div>
    );
  }

  const feats = bundle.capabilities.features;
  const navTabs = [
    { id: 'workbench', label: '工作台', visible: true },
    { id: 'governance', label: '团队与治理', visible: feats.teamObservability },
    { id: 'providers', label: '网关与供应商', visible: feats.magpieGateway || feats.directProviders },
    { id: 'models', label: '模型池与角色', visible: feats.modelPoolWrite || feats.roleConfigWrite },
    { id: 'hengzhang', label: '衡账分析', visible: feats.usageAnalytics },
    { id: 'system', label: '系统与外观', visible: true },
  ].filter(t => t.visible);

  return (
    <div className="lt-app">
      <header className="lt-header">
        <div className="lt-brand">
          <HeluoxuMark size={22} />
          <div>
            <div className="lt-brand-title">Leader Team</div>
            <div className="lt-brand-sub">
              {bundle.capabilities.backendLine} · Apache-2.0
            </div>
          </div>
        </div>

        <nav className="lt-nav" role="tablist" aria-label="Leader Team 主导航">
          {navTabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className="lt-nav-tab"
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="lt-header-right">
          {/* Gateway quick indicator */}
          <button
            type="button"
            className="lt-btn lt-btn-sm"
            onClick={() => setActiveTab('providers')}
            title="点击管理 Magpie 网关与供应商"
          >
            <span
              className={`lt-dot ${
                bundle.gateway.state === 'running'
                  ? 'lt-dot-ready'
                  : bundle.gateway.state === 'error'
                    ? 'lt-dot-error'
                    : 'lt-dot-warn'
              }`}
            />
            Magpie: {bundle.gateway.state}
          </button>

          <span className="lt-header-sep" />

          {/* Quick 4-theme pill switcher */}
          <div style={{ display: 'inline-flex', gap: 3 }} role="group" aria-label="快速切换主题">
            {(
              [
                ['white', '白'],
                ['dark', '黑'],
                ['heluoxu', '河洛序'],
                ['custom', '自定'],
              ] as Array<[ThemePresetId, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`lt-btn lt-btn-sm ${theme === id ? 'lt-btn-primary' : ''}`}
                onClick={() => void handleThemeChange(id, customTheme)}
              >
                {label}
              </button>
            ))}
          </div>

          {bundle.capabilities.frontendSwitch.available && bundle.capabilities.frontendSwitch.dshFrontendUrl && (
            <>
              <span className="lt-header-sep" />
              <a
                href={bundle.capabilities.frontendSwitch.dshFrontendUrl}
                className="lt-btn lt-btn-primary lt-btn-sm"
                title="共享同一运行时、工程状态与活跃团队会话，切换不会中断运行中的团队"
              >
                切换至 DSH 原生前端 ↗
              </a>
            </>
          )}
        </div>
      </header>

      <main className="lt-main">
        {activeTab === 'workbench' && (
          <WorkbenchView
            bundle={bundle}
            onRefreshBundle={refreshBundle}
            onNavigateTab={setActiveTab}
          />
        )}
        {activeTab === 'governance' && (
          <GovernanceView bundle={bundle} onRefreshBundle={refreshBundle} />
        )}
        {activeTab === 'providers' && (
          <ProvidersView bundle={bundle} onRefreshBundle={refreshBundle} />
        )}
        {activeTab === 'models' && (
          <ModelsRolesView bundle={bundle} onRefreshBundle={refreshBundle} />
        )}
        {activeTab === 'hengzhang' && (
          <HengzhangView bundle={bundle} onRefreshBundle={refreshBundle} />
        )}
        {activeTab === 'system' && (
          <SystemAppearanceView
            bundle={bundle}
            theme={theme}
            customTheme={customTheme}
            onChangeTheme={handleThemeChange}
            onRefreshBundle={refreshBundle}
          />
        )}
      </main>
    </div>
  );
}
