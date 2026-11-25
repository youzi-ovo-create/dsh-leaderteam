import React, { useEffect, useState } from 'react';
import {
  applyThemeToDom,
  callLtApi,
  computeContrastRatio,
  type HydratedBundle,
} from '../lib/api';
import type { CustomThemeSeeds, ThemePresetId } from '../types/lt-public-v1';

const THEME_PRESET_CARDS: Array<{
  id: ThemePresetId;
  title: string;
  subtitle: string;
  swatchBg: string;
  swatchSurface: string;
  swatchInk: string;
  swatchAccent: string;
}> = [
  {
    id: 'white',
    title: '白色主题（默认）',
    subtitle: '清爽日光工程工作台 (#FFFFFF / #F7F8FA)，>18:1 文字对比度，适合全天候高密度编码与观察',
    swatchBg: '#F7F8FA',
    swatchSurface: '#FFFFFF',
    swatchInk: '#141619',
    swatchAccent: '#9C5B2E',
  },
  {
    id: 'dark',
    title: '黑色主题',
    subtitle: '分层深碳石板 (#0F1115 / #1A1E26)，抑制纯黑眩光，暗铜信号点缀',
    swatchBg: '#0F1115',
    swatchSurface: '#1A1E26',
    swatchInk: '#ECEFF4',
    swatchAccent: '#D29A68',
  },
  {
    id: 'heluoxu',
    title: '河洛序主题',
    subtitle: '传承河洛序 V2 宣纸暖调 (#F5F3EE)、焦铜轴线、宋体标题与胶囊主按钮',
    swatchBg: '#F5F3EE',
    swatchSurface: '#FAF8F4',
    swatchInk: '#1A1916',
    swatchAccent: '#9C5B2E',
  },
  {
    id: 'custom',
    title: '用户自定义主题',
    subtitle: '8 项核心种子变量实时调色，基于 CSS color-mix 自动推导全套发丝边框与次级字色',
    swatchBg: '#EEF2F6',
    swatchSurface: '#FFFFFF',
    swatchInk: '#1B3039',
    swatchAccent: '#2A657C',
  },
];

export function SystemAppearanceView({
  bundle,
  theme,
  customTheme,
  onPreviewTheme,
  onChangeTheme,
  onRefreshBundle,
}: {
  bundle: HydratedBundle;
  theme: ThemePresetId;
  customTheme: CustomThemeSeeds;
  onPreviewTheme?: (nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) => void;
  onChangeTheme: (nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) => Promise<void>;
  onRefreshBundle: () => Promise<void>;
}) {
  const [seeds, setSeeds] = useState<CustomThemeSeeds>(customTheme);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setSeeds(customTheme);
  }, [customTheme]);

  const contrast = computeContrastRatio(seeds.surfaceColor, seeds.inkColor);

  function handleLiveSeedChange<K extends keyof CustomThemeSeeds>(key: K, val: CustomThemeSeeds[K]) {
    const next = { ...seeds, [key]: val };
    setSeeds(next);
    if (onPreviewTheme) {
      onPreviewTheme('custom', next);
    } else {
      applyThemeToDom('custom', next);
    }
  }

  async function handlePersistCustomTheme() {
    setBusy(true);
    try {
      await onChangeTheme('custom', seeds);
      setNotice('自定义主题已持久化至本地与服务端 ui-preferences.json');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetWhite() {
    const defSeeds: CustomThemeSeeds = {
      canvasColor: '#F7F8FA',
      surfaceColor: '#FFFFFF',
      inkColor: '#141619',
      accentColor: '#9C5B2E',
      dangerColor: '#A3263F',
      headingFontMode: 'serif',
      cornerStyle: 'balanced',
      density: 'standard',
    };
    setSeeds(defSeeds);
    await onChangeTheme('white', defSeeds);
    setNotice('已恢复默认白色工程主题');
  }

  async function handleTogglePlugin(pluginKey: string, enabled: boolean) {
    setBusy(true);
    try {
      await callLtApi('runtime/configure', {
        target: 'local',
        changes: { setPlugins: { [pluginKey]: enabled } },
      });
      setNotice(`插件开关 ${pluginKey} 已更新为 ${enabled ? '启用' : '拆卸'}`);
      await onRefreshBundle();
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePower(enabled: boolean) {
    setBusy(true);
    try {
      await callLtApi('runtime/configure', {
        target: 'local',
        changes: { setPowerMonitor: { enabled } },
      });
      setNotice(`电池感知收尾护栏已${enabled ? '启用' : '关闭'}`);
      await onRefreshBundle();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="lt-section-header">
        <div>
          <div className="lt-section-kicker">Unified Design Variables & System Guardrails</div>
          <h1 className="lt-section-title">系统设置、四套主题外观与双线公共契约状态</h1>
          <p className="lt-section-desc">
            单一 <code>--lt-*</code> 设计变量体系驱动全站，不维护多套冗余前端；默认采用白色工程背景，支持一键切换黑色、河洛序及自定义主题。
          </p>
        </div>
        <button className="lt-btn" onClick={() => void handleResetWhite()}>重置为默认白色主题</button>
      </div>

      {notice && <div className="lt-banner"><span>{notice}</span><button className="lt-btn lt-btn-sm" onClick={() => setNotice(null)}>关闭</button></div>}

      {/* 1. Theme Preset Cards */}
      <div className="lt-grid-kpi" style={{ marginBottom: 20 }}>
        {THEME_PRESET_CARDS.map(card => {
          const active = theme === card.id;
          return (
            <button
              key={card.id}
              type="button"
              className="lt-card"
              onClick={() => void onChangeTheme(card.id, seeds)}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                borderColor: active ? 'var(--lt-accent)' : 'var(--lt-border-subtle)',
                boxShadow: active ? 'inset 0 2px 0 var(--lt-accent)' : 'none',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[card.swatchBg, card.swatchSurface, card.swatchInk, card.swatchAccent].map((hex, idx) => (
                    <span
                      key={idx}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: hex,
                        border: '1px solid rgba(128,128,128,0.35)',
                        display: 'inline-block',
                      }}
                    />
                  ))}
                </div>
                {active && <span className="lt-seal">当前启用</span>}
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--lt-fg-primary)' }}>{card.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--lt-fg-secondary)', marginTop: 4 }}>{card.subtitle}</div>
            </button>
          );
        })}
      </div>

      <div className="lt-grid-2">
        {/* 2. Custom Theme Studio */}
        <div className="lt-card lt-card-authority">
          <div className="lt-card-title">
            <span>自定义主题设计工作台 (Custom Theme Studio)</span>
            <span className="lt-tag lt-num">
              文字对比度 {contrast}:1 {contrast >= 7 ? '(WCAG AAA)' : contrast >= 4.5 ? '(WCAG AA)' : '⚠ 偏低'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <label style={{ fontSize: 12 }}>
              工作区底色 (canvasColor)
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input type="color" value={seeds.canvasColor} onChange={e => handleLiveSeedChange('canvasColor', e.target.value)} />
                <input className="lt-input lt-mono" value={seeds.canvasColor} onChange={e => handleLiveSeedChange('canvasColor', e.target.value)} />
              </div>
            </label>
            <label style={{ fontSize: 12 }}>
              面板卡片表面 (surfaceColor)
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input type="color" value={seeds.surfaceColor} onChange={e => handleLiveSeedChange('surfaceColor', e.target.value)} />
                <input className="lt-input lt-mono" value={seeds.surfaceColor} onChange={e => handleLiveSeedChange('surfaceColor', e.target.value)} />
              </div>
            </label>
            <label style={{ fontSize: 12 }}>
              主墨字色 / 按钮底色 (inkColor)
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input type="color" value={seeds.inkColor} onChange={e => handleLiveSeedChange('inkColor', e.target.value)} />
                <input className="lt-input lt-mono" value={seeds.inkColor} onChange={e => handleLiveSeedChange('inkColor', e.target.value)} />
              </div>
            </label>
            <label style={{ fontSize: 12 }}>
              信号与轴线强调色 (accentColor)
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input type="color" value={seeds.accentColor} onChange={e => handleLiveSeedChange('accentColor', e.target.value)} />
                <input className="lt-input lt-mono" value={seeds.accentColor} onChange={e => handleLiveSeedChange('accentColor', e.target.value)} />
              </div>
            </label>
            <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>
              警示与封缄朱印色 (dangerColor)
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input type="color" value={seeds.dangerColor} onChange={e => handleLiveSeedChange('dangerColor', e.target.value)} />
                <input className="lt-input lt-mono" value={seeds.dangerColor} onChange={e => handleLiveSeedChange('dangerColor', e.target.value)} />
              </div>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
            <label style={{ fontSize: 12 }}>
              标题字体气质
              <select
                className="lt-select"
                style={{ marginTop: 4 }}
                value={seeds.headingFontMode}
                onChange={e => handleLiveSeedChange('headingFontMode', e.target.value as 'serif' | 'sans')}
              >
                <option value="serif">河洛序衬线体 (Serif)</option>
                <option value="sans">现代工程无衬线 (Sans)</option>
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              圆角与按钮几何
              <select
                className="lt-select"
                style={{ marginTop: 4 }}
                value={seeds.cornerStyle}
                onChange={e => handleLiveSeedChange('cornerStyle', e.target.value as any)}
              >
                <option value="sharp">锐利几何 (0-2px)</option>
                <option value="balanced">工程均衡 (6-8px)</option>
                <option value="pill-cta">河洛胶囊按钮 (999px)</option>
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              信息密度排版
              <select
                className="lt-select"
                style={{ marginTop: 4 }}
                value={seeds.density}
                onChange={e => handleLiveSeedChange('density', e.target.value as any)}
              >
                <option value="compact">高密度紧凑 (12px)</option>
                <option value="standard">标准工程 (13px)</option>
                <option value="comfortable">舒展阅读 (14.5px)</option>
              </select>
            </label>
          </div>

          <button className="lt-btn lt-btn-primary" disabled={busy} onClick={() => void handlePersistCustomTheme()}>
            应用并持久化自定义主题
          </button>
        </div>

        {/* 3. Detachable Sub-Plugins & Capability Contract Inspector */}
        <div className="lt-card">
          <h2 className="lt-card-title">
            <span>可拆卸模块护栏 & 后端能力契约 (lt.public.v1)</span>
            <span className="lt-mono" style={{ fontSize: 11 }}>{bundle.capabilities.backendLine}</span>
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {[
              { key: 'scheduler', name: '弹性并发调度器 (leaderteam-scheduler)' },
              { key: 'consensus', name: '对称双审与治理会议 (leaderteam-consensus)' },
              { key: 'timerArchive', name: '工程计时与外部归档 (leaderteam-timer-archive)' },
            ].map(item => {
              const active = bundle.runtime.activePlugins?.[item.key] !== false;
              return (
                <div
                  key={item.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 10px',
                    background: 'var(--lt-bg-subtle)',
                    borderRadius: 'var(--lt-radius-sm)',
                  }}
                >
                  <span>{item.name}</span>
                  <button className="lt-btn lt-btn-sm" disabled={busy} onClick={() => void handleTogglePlugin(item.key, !active)}>
                    {active ? '运行中 (点击拆卸)' : '已拆卸 (点击启用)'}
                  </button>
                </div>
              );
            })}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 10px',
                background: 'var(--lt-bg-subtle)',
                borderRadius: 'var(--lt-radius-sm)',
              }}
            >
              <span>电池感知安全收尾 (powerMonitor.enabled)</span>
              <button
                className="lt-btn lt-btn-sm"
                disabled={busy}
                onClick={() => void handleTogglePower(!bundle.runtime.power.enabled)}
              >
                {bundle.runtime.power.enabled ? '已启用 (点击关闭)' : '已关闭 (点击启用)'}
              </button>
            </div>
          </div>

          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--lt-fg-muted)', marginBottom: 6 }}>
            当前后端声明能力位 (BackendCapabilities.features)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(bundle.capabilities.features).map(([k, v]) => (
              <span key={k} className="lt-tag lt-mono" style={{ opacity: v ? 1 : 0.45 }}>
                {v ? '✓' : '×'} {k}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
