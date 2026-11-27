import React, { useEffect, useState } from 'react';
import { callLtApi, type HydratedBundle } from '../lib/api';
import {
  DEFAULT_CUSTOM_SEEDS,
  PRESET_THEME_TOKENS,
  SEED_PRESETS,
  cornerStyleToRadius,
  deriveCustomTheme,
  getContrastReport,
  radiusToCornerStyle,
  type DensityMode,
  type DisplayFontMode,
  type RadiusStyle,
} from '../lib/theme';
import { Icon, type IconName } from '../components/Icon';
import { HeluoxuMark } from '../components/HeluoxuMark';
import { Splitter, StageHead } from '../components/AppShell';
import { UnknownValue } from '../components/UnknownValue';
import type { CustomThemeSeeds, ThemePresetId } from '../types/lt-public-v1';

export type SettingsSubId = 'appearance' | 'modules' | 'updates' | 'about';

function ThemeMiniPreview({
  canvas,
  subtle,
  surface,
  ink,
  accent,
}: {
  canvas: string;
  subtle: string;
  surface: string;
  ink: string;
  accent: string;
}) {
  return (
    <div className="theme-mini" style={{ background: surface }}>
      <i style={{ background: canvas }} />
      <i style={{ background: subtle, borderRight: '1px solid rgba(128,128,128,0.18)', padding: '8px 5px' }}>
        <b style={{ display: 'block', height: 4, borderRadius: 2, background: ink, opacity: 0.5, marginBottom: 5 }} />
        <b style={{ display: 'block', height: 4, borderRadius: 2, background: ink, opacity: 0.25, marginBottom: 5 }} />
        <b style={{ display: 'block', height: 4, borderRadius: 2, background: accent, opacity: 0.85 }} />
      </i>
      <i style={{ padding: 10 }}>
        <b style={{ display: 'block', height: 5, width: '70%', borderRadius: 2, background: ink, opacity: 0.75, marginBottom: 7 }} />
        <b style={{ display: 'block', height: 4, width: '90%', borderRadius: 2, background: ink, opacity: 0.3, marginBottom: 5 }} />
        <b style={{ display: 'block', height: 4, width: '60%', borderRadius: 2, background: ink, opacity: 0.3, marginBottom: 10 }} />
        <b style={{ display: 'inline-block', height: 12, width: 34, borderRadius: 3, background: accent }} />
      </i>
    </div>
  );
}

export function SettingsView({
  bundle,
  theme,
  customTheme,
  density = 'comfortable',
  display = 'serif',
  initialSub,
  ctxOpen = true,
  onToggleCtx,
  onPreviewTheme,
  onChangeTheme,
  onChangeDensity,
  onChangeDisplay,
  onNavigateSub,
  onRefreshBundle,
  onOpenOnboarding,
  onNotify,
}: {
  bundle: HydratedBundle;
  theme: ThemePresetId;
  customTheme: CustomThemeSeeds;
  density?: DensityMode;
  display?: DisplayFontMode;
  initialSub?: string | null;
  ctxOpen?: boolean;
  onToggleCtx?: () => void;
  onPreviewTheme?: (nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) => void;
  onChangeTheme: (nextTheme: ThemePresetId, nextSeeds: CustomThemeSeeds) => Promise<void>;
  onChangeDensity?: (next: DensityMode) => void;
  onChangeDisplay?: (next: DisplayFontMode) => void;
  onNavigateSub?: (sub: SettingsSubId) => void;
  onRefreshBundle: () => Promise<void>;
  onOpenOnboarding?: () => void;
  onNotify?: (message: string, icon?: IconName) => void;
}) {
  const [localSub, setLocalSub] = useState<SettingsSubId>(
    initialSub === 'modules' || initialSub === 'updates' || initialSub === 'about'
      ? initialSub
      : 'appearance',
  );
  const [seeds, setSeeds] = useState<CustomThemeSeeds>(customTheme);
  const [busy, setBusy] = useState(false);
  const [pendingModules, setPendingModules] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateCheckRes, setUpdateCheckRes] = useState<any>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [crossTrackAck, setCrossTrackAck] = useState(false);

  useEffect(() => {
    setSeeds(customTheme);
  }, [customTheme]);

  const activeSub: SettingsSubId =
    initialSub === 'appearance' || initialSub === 'modules' || initialSub === 'updates' || initialSub === 'about'
      ? initialSub
      : localSub;

  function goSub(sub: SettingsSubId) {
    setLocalSub(sub);
    if (onNavigateSub) onNavigateSub(sub);
  }

  function notify(msg: string, icon: IconName = 'check') {
    setError(null);
    setNotice(msg);
    if (onNotify) onNotify(msg, icon);
  }

  function reportError(msg: string) {
    setNotice(null);
    setError(msg);
    if (onNotify) onNotify(msg, 'alert');
  }

  function handleLiveSeedChange<K extends keyof CustomThemeSeeds>(key: K, val: CustomThemeSeeds[K]) {
    const next = { ...seeds, [key]: val };
    setSeeds(next);
    if (onPreviewTheme) {
      onPreviewTheme('custom', next);
    }
  }

  async function handleSelectTheme(nextTheme: ThemePresetId) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await onChangeTheme(nextTheme, seeds);
      notify('主题偏好已保存至本地与服务端 ui-preferences.json', 'check');
    } catch (e: any) {
      reportError(`主题服务端保存失败（仅更新本地预览）：${e?.message || '请求失败'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePersistCustomTheme() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await onChangeTheme('custom', seeds);
      notify('自定义主题已持久化至本地与服务端 ui-preferences.json', 'check');
    } catch (e: any) {
      reportError(`自定义主题服务端保存失败（仅更新本地预览）：${e?.message || '请求失败'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetCustomSeeds() {
    setBusy(true);
    setNotice(null);
    setError(null);
    setSeeds(DEFAULT_CUSTOM_SEEDS);
    try {
      await onChangeTheme('custom', DEFAULT_CUSTOM_SEEDS);
      notify('已恢复默认自定义种子色', 'rollback');
    } catch (e: any) {
      reportError(`恢复默认主题服务端保存失败（仅更新本地预览）：${e?.message || '请求失败'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePlugin(pluginKey: string, enabled: boolean) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await callLtApi('runtime/configure', {
        target: 'local',
        changes: { setPlugins: { [pluginKey]: enabled } },
      });
      setPendingModules(prev => ({ ...prev, [pluginKey]: true }));
      notify(`模块 ${pluginKey} 已更新为${enabled ? '启用' : '拆卸停用'}`, 'check');
      await onRefreshBundle();
    } catch (e: any) {
      reportError(`模块 ${pluginKey} 保存失败：${e?.message || '请求失败'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePower(enabled: boolean) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await callLtApi('runtime/configure', {
        target: 'local',
        changes: { setPowerMonitor: { enabled } },
      });
      notify(`电池感知安全收尾已${enabled ? '启用' : '关闭'}`, 'check');
      await onRefreshBundle();
    } catch (e: any) {
      reportError(`电源守护设置保存失败：${e?.message || '请求失败'}`);
    } finally {
      setBusy(false);
    }
  }

  const contrastRows = getContrastReport(theme, seeds);
  const derivedCustom = deriveCustomTheme(seeds);
  const currentRadius = cornerStyleToRadius(seeds.cornerStyle);
  const contractVer = bundle.capabilities.features.inSessionDualMode ? '1.1.0' : '1.0.1';

  const titles: Record<SettingsSubId, string> = {
    appearance: '外观',
    modules: '功能模块',
    updates: '版本更新与宿主兼容',
    about: '关于',
  };

  async function handleCheckUpdate(targetTrack?: string | null) {
    setCheckingUpdate(true);
    setError(null);
    try {
      const res = await callLtApi<any>('system/update', {
        action: 'check',
        track: targetTrack || undefined,
        force: true,
      });
      setUpdateCheckRes(res.check);
      await onRefreshBundle();
      if (res.check?.hasUpdate && res.check?.latestRelease) {
        notify(`发现可用版本 v${res.check.latestRelease.version}！`, 'spark');
      } else {
        notify('当前已是所选发行分支的最新版本。', 'check');
      }
    } catch (e: any) {
      reportError(e?.message || '检查更新失败');
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleToggleAutoUpdate(enabled: boolean) {
    setBusy(true);
    try {
      await callLtApi('system/update', { action: 'toggle-auto-check', enabled });
      await onRefreshBundle();
      notify(enabled ? '已开启启动时自动检查新版本' : '已关闭自动检查更新', 'check');
    } catch (e: any) {
      reportError(e?.message || '更新偏好保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleApplyOneClickUpgrade(opts: { targetTrack?: string; confirmTrackSwitch?: string } = {}) {
    setUpgrading(true);
    setError(null);
    setNotice('正在下载安装包、校验 SHA-256、检查宿主兼容性并创建回滚快照…');
    try {
      const res = await callLtApi<any>('system/update', {
        action: 'apply',
        ...(opts.targetTrack ? { targetTrack: opts.targetTrack } : {}),
        ...(opts.confirmTrackSwitch ? { confirmTrackSwitch: opts.confirmTrackSwitch } : {}),
      });
      const r = res?.result;
      if (r?.asyncApplying) {
        setNotice(r.message || '正在后台热替换升级，请稍候…');
        const targetVer = r.toVersion;
        for (let i = 0; i < 18; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            const st = await callLtApi<any>('system/update', { action: 'status' });
            if (st?.installed?.version === targetVer || st?.state?.phase === 'succeeded') {
              await onRefreshBundle();
              setUpdateCheckRes(null);
              notify(`已无感完成升级（v${targetVer}），所有模型配置、历史会话与团队记录已完整保留！`, 'check');
              return;
            }
            if (st?.state?.phase === 'rolled_back' || st?.state?.phase === 'failed') {
              throw new Error(st?.state?.lastError || '升级失败，已自动回滚至原版本');
            }
          } catch (pollErr: any) {
            if (pollErr?.message?.includes('回滚')) throw pollErr;
          }
        }
        await onRefreshBundle();
        notify('后台升级已提交，请刷新页面确认最新状态。', 'info');
      } else {
        await onRefreshBundle();
        setUpdateCheckRes(null);
        notify(r?.message || `已成功安装 v${r?.toVersion || ''}`, 'check');
      }
    } catch (e: any) {
      reportError(e?.message || '一键升级失败');
    } finally {
      setUpgrading(false);
    }
  }

  async function handleRollback(backupId?: string) {
    setUpgrading(true);
    setError(null);
    try {
      const res = await callLtApi<any>('system/update', {
        action: 'rollback',
        ...(backupId ? { backupId } : {}),
      });
      if (res?.result?.asyncApplying) {
        setNotice(res.result.message || '正在热回滚至上一版本…');
        await new Promise(resolve => setTimeout(resolve, 3500));
      }
      await onRefreshBundle();
      notify(res?.result?.message || '已成功回滚至历史备份版本', 'check');
    } catch (e: any) {
      reportError(e?.message || '版本回滚失败');
    } finally {
      setUpgrading(false);
    }
  }

  const leadingToggle =
    !ctxOpen && onToggleCtx ? (
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={onToggleCtx}
        title="展开设置栏（Ctrl+B）"
      >
        <Icon name="panelL" />
      </button>
    ) : undefined;

  return (
    <div className="body" style={{ flex: 1 }}>
      <aside
        className={`pane pane-context${ctxOpen ? '' : ' is-floating-hidden'}`}
        hidden={!ctxOpen}
        aria-label="设置子导航"
      >
        <div className="pane-head">
          <span className="t-subhead" style={{ fontSize: 14 }}>
            设置
          </span>
        </div>
        <div className="list" style={{ paddingTop: 8 }}>
          {(
            [
              ['appearance', '外观', 'contrast'],
              ['modules', '功能模块', 'layers'],
              ['updates', '版本更新与兼容', 'refresh'],
              ['about', '关于', 'info'],
            ] as Array<[SettingsSubId, string, IconName]>
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              className="list-item"
              style={{ alignItems: 'center' }}
              aria-current={activeSub === id ? 'true' : undefined}
              onClick={() => goSub(id)}
            >
              <Icon name={icon} />
              <span className="t-small" style={{ fontWeight: 500 }}>
                {label}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <Splitter which="ctx" hidden={!ctxOpen} />

      <main className="stage">
        <StageHead overline="设置" title={titles[activeSub]} leading={leadingToggle} />

        <div className="stage-body">
          <div className="stage-pad" style={{ maxWidth: 1100 }}>
            {error && (
              <div className="callout danger" role="alert" style={{ marginBottom: 18 }}>
                <Icon name="alert" />
                <span className="grow">{error}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                  关闭
                </button>
              </div>
            )}

            {notice && (
              <div className="callout info" style={{ marginBottom: 18 }}>
                <Icon name="info" />
                <span className="grow">{notice}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>
                  关闭
                </button>
              </div>
            )}

            {/* ==================== APPEARANCE ==================== */}
            {activeSub === 'appearance' && (
              <>
                <div className="section">
                  <div className="section-head">
                    <div>
                      <span className="t-overline">主题</span>
                      <h2>四套主题</h2>
                    </div>
                  </div>
                  <div className="grid grid-4">
                    {(
                      [
                        ['white', '白色', '日光工程白 · 默认'],
                        ['dark', '黑色', '深碳石板 · 低眩光'],
                        ['heluoxu', '河洛序', '宣纸焦铜 · 宋刻标题'],
                        ['custom', '自定义', '种子色推导 · 对比度护栏'],
                      ] as Array<[ThemePresetId, string, string]>
                    ).map(([id, title, sub]) => {
                      const preview =
                        id === 'custom'
                          ? {
                              canvas: seeds.canvasColor,
                              subtle: derivedCustom.tokens['--lt-bg-subtle'],
                              surface: seeds.surfaceColor,
                              ink: derivedCustom.tokens['--lt-fg-primary'],
                              accent: derivedCustom.tokens['--lt-accent'],
                            }
                          : {
                              canvas: PRESET_THEME_TOKENS[id].canvas,
                              subtle: PRESET_THEME_TOKENS[id].subtle,
                              surface: PRESET_THEME_TOKENS[id].surface,
                              ink: PRESET_THEME_TOKENS[id].primary,
                              accent: PRESET_THEME_TOKENS[id].accent,
                            };
                      return (
                        <button
                          key={id}
                          type="button"
                          className="theme-card"
                          aria-pressed={theme === id}
                          disabled={busy}
                          onClick={() => void handleSelectTheme(id)}
                        >
                          <ThemeMiniPreview {...preview} />
                          <span className="col" style={{ gap: 1, padding: '0 2px 2px' }}>
                            <b className="t-small">{title}</b>
                            <span className="t-meta">{sub}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="section grid grid-2">
                  <div className="field">
                    <span className="label">信息密度</span>
                    <div className="seg">
                      <button
                        type="button"
                        aria-pressed={density === 'comfortable'}
                        onClick={() => {
                          if (onChangeDensity) onChangeDensity('comfortable');
                        }}
                      >
                        舒适 · 32px 控件
                      </button>
                      <button
                        type="button"
                        aria-pressed={density === 'compact'}
                        onClick={() => {
                          if (onChangeDensity) onChangeDensity('compact');
                        }}
                      >
                        紧凑 · 28px 控件
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <span className="label">标题字体</span>
                    <div className="seg">
                      <button
                        type="button"
                        aria-pressed={display === 'serif'}
                        onClick={() => {
                          if (onChangeDisplay) onChangeDisplay('serif');
                        }}
                      >
                        <span style={{ fontFamily: 'var(--hl-font-serif)' }}>宋刻衬线</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={display === 'sans'}
                        onClick={() => {
                          if (onChangeDisplay) onChangeDisplay('sans');
                        }}
                      >
                        现代无衬线
                      </button>
                    </div>
                  </div>
                </div>

                {theme === 'custom' && (
                  <div className="section">
                    <div className="section-head">
                      <div>
                        <span className="t-overline">自定义</span>
                        <h2>种子色与推导</h2>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void handleResetCustomSeeds()}
                        >
                          <Icon name="rollback" className="icon-14" />
                          恢复默认种子
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          onClick={() => void handlePersistCustomTheme()}
                        >
                          保存并持久化
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-2" style={{ gap: 20 }}>
                      <div className="card card-pad col" style={{ gap: 12 }}>
                        {(
                          [
                            ['canvasColor', '画布色'],
                            ['surfaceColor', '表面色'],
                            ['inkColor', '墨色（正文）'],
                            ['accentColor', '强调色'],
                            ['dangerColor', '危险色'],
                          ] as Array<[keyof CustomThemeSeeds, string]>
                        ).map(([field, label]) => (
                          <div key={field} className="row" style={{ gap: 10 }}>
                            <label className="swatch" style={{ background: String(seeds[field]) }}>
                              <input
                                type="color"
                                aria-label={label}
                                value={String(seeds[field])}
                                onChange={e => handleLiveSeedChange(field, e.target.value.toUpperCase() as any)}
                              />
                            </label>
                            <span className="grow t-small">{label}</span>
                            <input
                              className="input input-sm mono"
                              style={{ width: 104 }}
                              value={String(seeds[field])}
                              onChange={e => handleLiveSeedChange(field, e.target.value.toUpperCase() as any)}
                            />
                          </div>
                        ))}

                        <div className="field">
                          <span className="label">圆角风格</span>
                          <div className="seg seg-sm">
                            {(
                              [
                                ['sharp', '锐利'],
                                ['standard', '标准'],
                                ['round', '圆润'],
                              ] as Array<[RadiusStyle, string]>
                            ).map(([r, lbl]) => (
                              <button
                                key={r}
                                type="button"
                                aria-pressed={currentRadius === r}
                                onClick={() => handleLiveSeedChange('cornerStyle', radiusToCornerStyle(r))}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                          <span className="t-meta">预设起点：</span>
                          {SEED_PRESETS.map(p => (
                            <button
                              key={p.name}
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                const next: CustomThemeSeeds = {
                                  ...seeds,
                                  canvasColor: p.canvasColor,
                                  surfaceColor: p.surfaceColor,
                                  inkColor: p.inkColor,
                                  accentColor: p.accentColor,
                                  dangerColor: p.dangerColor,
                                };
                                setSeeds(next);
                                if (onPreviewTheme) onPreviewTheme('custom', next);
                              }}
                            >
                              <span
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: 2,
                                  background: p.accentColor,
                                  display: 'inline-block',
                                }}
                              />
                              {p.name}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="card">
                        <div className="card-head">
                          <h3>对比度护栏</h3>
                          <span className="t-meta">WCAG 2.x</span>
                        </div>
                        <table className="tbl">
                          <tbody>
                            {contrastRows.map(r => {
                              const cls =
                                r.grade === 'AAA' || r.grade === 'AA'
                                  ? 'success'
                                  : r.grade === '不足'
                                    ? 'danger'
                                    : 'warning';
                              return (
                                <tr key={r.label}>
                                  <td>
                                    <span className="row" style={{ gap: 8 }}>
                                      <span
                                        style={{
                                          width: 22,
                                          height: 16,
                                          borderRadius: 3,
                                          background: r.bg,
                                          border: '1px solid var(--lt-border-strong)',
                                          display: 'grid',
                                          placeItems: 'center',
                                          fontSize: 10,
                                          color: r.fg,
                                          fontWeight: 700,
                                        }}
                                      >
                                        Aa
                                      </span>
                                      {r.label}
                                    </span>
                                  </td>
                                  <td className="r num">{r.ratio.toFixed(2)}:1</td>
                                  <td>
                                    <span className={`badge sm ${cls}`}>{r.grade}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div className="hint" style={{ padding: '10px 16px' }}>
                          弱化文字与强调色低于 4.5:1 时自动向墨色方向加深；按钮文字自动在黑 / 白中择优。
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="section">
                  <div className="section-head">
                    <div>
                      <span className="t-overline">预览</span>
                      <h2>组件在当前主题下</h2>
                    </div>
                  </div>
                  <div className="card card-pad col" style={{ gap: 14 }}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-primary">
                        主要操作
                      </button>
                      <button type="button" className="btn">
                        次要
                      </button>
                      <button type="button" className="btn btn-ghost">
                        幽灵
                      </button>
                      <button type="button" className="btn btn-danger">
                        危险
                      </button>
                      <span className="mode-badge team">Team</span>
                      <span className="mode-badge single">Single</span>
                      <span className="badge success">成功</span>
                      <span className="badge warning">未定价</span>
                      <span className="badge danger">拦截</span>
                      <span className="seal">契</span>
                      <span className="layer local">local</span>
                    </div>
                    <div className="tools" style={{ maxWidth: 640 }}>
                      <div className="tool">
                        <div className="tool-row">
                          <span className="tool-ico">
                            <Icon name="edit" />
                          </span>
                          <span className="tool-name">edit</span>
                          <span className="tool-target">packages/gateway/health/backoff.ts</span>
                          <span className="badge sm success">
                            <Icon name="shield" />
                            放行
                          </span>
                          <span className="tool-dur">0.4 s</span>
                          <Icon name="chevR" className="chev icon-14" />
                        </div>
                      </div>
                    </div>
                    <p className="t-small" style={{ margin: 0, maxWidth: 640, lineHeight: 1.75 }}>
                      正文示例：领队以 <code>deepseek/deepseek-reasoner</code> 编排 5 个阶段，本轮耗时{' '}
                      <span className="num">6m 12s</span>，缓存命中率{' '}
                      <span className="num" style={{ color: 'var(--lt-success)' }}>
                        74.2%
                      </span>
                      ，<UnknownValue /> 表示未知而非 0。
                    </p>
                  </div>
                </div>
              </>
            )}

            {/* ==================== MODULES ==================== */}
            {activeSub === 'modules' && (
              <>
                <div className="section">
                  <div className="section-head">
                    <div>
                      <span className="t-overline">可拆卸</span>
                      <h2>功能模块与运行护栏</h2>
                    </div>
                  </div>
                  <div className="card">
                    {[
                      {
                        key: 'scheduler',
                        name: '弹性并发调度 (leaderteam-scheduler)',
                        desc: '根据设备负载、5h 请求窗口与时间压力动态计算有效成员并发上限。',
                        checked: bundle.runtime.activePlugins?.scheduler !== false,
                        onToggle: (next: boolean) => void handleTogglePlugin('scheduler', next),
                      },
                      {
                        key: 'consensus',
                        name: '对称双审与治理会议 (leaderteam-consensus)',
                        desc: '有责双评审（discussA / discussB）、独立裁断（arbiter）与写域冲突暂停屏障。',
                        checked: bundle.runtime.activePlugins?.consensus !== false,
                        onToggle: (next: boolean) => void handleTogglePlugin('consensus', next),
                      },
                      {
                        key: 'timerArchive',
                        name: '工程计时与外部计划归档 (leaderteam-timer-archive)',
                        desc: '记录项目墙钟 / 活跃工作时长，并将完成计划落盘至独立外部归档目录。',
                        checked: bundle.runtime.activePlugins?.timerArchive !== false,
                        onToggle: (next: boolean) => void handleTogglePlugin('timerArchive', next),
                      },
                      {
                        key: 'powerMonitor',
                        name: '电源感知安全收尾 (powerMonitor.enabled)',
                        desc: '低于 20% 且处于电池供电时自动落盘检查点并进入安全收尾模式。',
                        checked: bundle.runtime.power.enabled,
                        onToggle: (next: boolean) => void handleTogglePower(next),
                      },
                    ].map((mod, idx) => (
                      <div
                        key={mod.key}
                        className="row"
                        style={{
                          gap: 14,
                          padding: '14px 16px',
                          borderTop: idx > 0 ? '1px solid var(--lt-border-subtle)' : undefined,
                        }}
                      >
                        <span className="col grow" style={{ gap: 2 }}>
                          <span className="row" style={{ gap: 8 }}>
                            <b className="t-small">{mod.name}</b>
                            {pendingModules[mod.key] && (
                              <span className="badge sm warning">待重载生效</span>
                            )}
                          </span>
                          <span className="t-meta">{mod.desc}</span>
                        </span>
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={mod.checked}
                            disabled={busy}
                            onChange={e => mod.onToggle(e.target.checked)}
                          />
                          <span className="track" />
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="section">
                  <div className="section-head">
                    <div>
                      <span className="t-overline">能力契约</span>
                      <h2>后端声明能力位 (lt.public.v1)</h2>
                    </div>
                  </div>
                  <div className="card card-pad">
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                      {Object.entries(bundle.capabilities.features).map(([k, v]) => (
                        <span
                          key={k}
                          className={`badge sm ${v ? 'outline' : ''}`}
                          style={{ fontFamily: 'var(--hl-font-mono)', opacity: v ? 1 : 0.45 }}
                        >
                          {v ? '✓' : '×'} {k}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ==================== UPDATES & HOST COMPATIBILITY ==================== */}
            {activeSub === 'updates' && (() => {
              const upd = bundle.updater;
              const installed = upd?.installed;
              const activeRel = updateCheckRes?.latestRelease ?? upd?.state?.availableUpdate ?? null;
              const hasNew = updateCheckRes ? Boolean(updateCheckRes.hasUpdate) : Boolean(upd?.state?.availableUpdate);
              const isCrossTrack = Boolean(updateCheckRes?.isCrossTrack);
              const otherTrackId = installed?.track === 'closed-free' ? 'open-source' : 'closed-free';
              const otherTrackInfo = upd?.tracks?.find(t => t.id === otherTrackId);
              const hostCompat = bundle.capabilities.hostCompatibility;
              const matrix = bundle.compatibilityMatrix;

              return (
                <>
                  <div className="section">
                    <div className="section-head">
                      <div>
                        <span className="t-overline">在线升级 · 自动备份回滚</span>
                        <h2>自动检查更新与一键升级</h2>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        {onOpenOnboarding && (
                          <button
                            type="button"
                            className="btn"
                            onClick={onOpenOnboarding}
                          >
                            <Icon name="spark" />
                            打开首次使用新手引导
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={checkingUpdate || upgrading}
                          onClick={() => void handleCheckUpdate(null)}
                        >
                          <Icon name="refresh" />
                          {checkingUpdate ? '正在检查…' : '立即检查更新'}
                        </button>
                      </div>
                    </div>

                    <div className="card card-pad" style={{ marginBottom: 16 }}>
                      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                        <div className="col" style={{ gap: 4 }}>
                          <div className="row" style={{ gap: 8 }}>
                            <b style={{ fontSize: 16 }}>当前版本：v{installed?.version || bundle.capabilities.backendVersion}</b>
                            <span className="badge outline">
                              {installed?.trackInfo?.label || '开源维护版 (Apache-2.0)'}
                            </span>
                            {hostCompat && (
                              <span className={`badge ${hostCompat.productionAllowed ? 'success' : 'danger'}`}>
                                DSH {hostCompat.toolsVersion || '未知'} · {hostCompat.classification}
                              </span>
                            )}
                          </div>
                          <span className="t-meta">
                            发行仓库：<code>{installed?.trackInfo?.repo || 'youzi-ovo-create/dsh-leaderteam'}</code>
                            {upd?.state?.lastCheckedAt ? ` · 上次检查：${new Date(upd.state.lastCheckedAt).toLocaleString()}` : ''}
                          </span>
                          <span className="t-meta">
                            升级承诺：一键校验 SHA-256、预检 DSH 宿主兼容性，自动保留全部模型配置、历史会话与团队账本；升级失败自动无损回滚。
                          </span>
                        </div>
                        <label className="row t-small" style={{ gap: 8 }}>
                          <span>自动检查新版本</span>
                          <span className="switch">
                            <input
                              type="checkbox"
                              checked={upd?.state?.autoCheckEnabled !== false}
                              disabled={busy}
                              onChange={e => void handleToggleAutoUpdate(e.target.checked)}
                            />
                            <span className="track" />
                          </span>
                        </label>
                      </div>
                    </div>

                    {hasNew && activeRel && (
                      <div className="card card-pad" style={{ border: '1.5px solid var(--lt-accent)', marginBottom: 16 }}>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                          <div className="col" style={{ gap: 4 }}>
                            <div className="row" style={{ gap: 8 }}>
                              <span className="badge success">发现新版本</span>
                              <b style={{ fontSize: 16 }}>{activeRel.name || `v${activeRel.version}`}</b>
                              <span className="mono t-meta">({activeRel.tagName})</span>
                            </div>
                            <span className="t-meta">
                              发布时间：{activeRel.publishedAt ? new Date(activeRel.publishedAt).toLocaleString() : '未知'}
                              {activeRel.asset?.size ? ` · 包大小：${(activeRel.asset.size / 1024).toFixed(1)} KB` : ''}
                            </span>
                          </div>
                          {!isCrossTrack ? (
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={upgrading || !activeRel.asset}
                              onClick={() => void handleApplyOneClickUpgrade()}
                            >
                              <Icon name="zap" />
                              {upgrading ? '正在下载校验并升级…' : `一键升级至 v${activeRel.version}`}
                            </button>
                          ) : (
                            <div className="col" style={{ gap: 6, alignItems: 'flex-end' }}>
                              <label className="row t-small" style={{ gap: 6 }}>
                                <input
                                  type="checkbox"
                                  checked={crossTrackAck}
                                  onChange={e => setCrossTrackAck(e.target.checked)}
                                />
                                我已知晓并确认切换到「{updateCheckRes?.queriedTrackInfo?.label}」
                              </label>
                              <button
                                type="button"
                                className="btn btn-danger"
                                disabled={!crossTrackAck || upgrading || !activeRel.asset}
                                onClick={() =>
                                  void handleApplyOneClickUpgrade({
                                    targetTrack: updateCheckRes.queriedTrack,
                                    confirmTrackSwitch: updateCheckRes.crossTrackConfirmationToken,
                                  })
                                }
                              >
                                确认切换分支并安装 v{activeRel.version}
                              </button>
                            </div>
                          )}
                        </div>
                        <div
                          style={{
                            background: 'var(--lt-subtle, rgba(128,128,128,0.06))',
                            padding: '12px 14px',
                            borderRadius: 6,
                            whiteSpace: 'pre-wrap',
                            fontSize: 13,
                            maxHeight: 240,
                            overflow: 'auto',
                          }}
                        >
                          {activeRel.body || '暂无详细更新日志。'}
                        </div>
                      </div>
                    )}

                    {/* Backups & Rollback */}
                    {upd?.backups && upd.backups.length > 0 && (
                      <div className="card card-pad" style={{ marginBottom: 16 }}>
                        <b className="t-small" style={{ display: 'block', marginBottom: 8 }}>
                          本地历史版本备份快照（支持离线一键回滚）
                        </b>
                        {upd.backups.map(b => (
                          <div
                            key={b.backupId}
                            className="row"
                            style={{
                              justifyContent: 'space-between',
                              padding: '8px 0',
                              borderTop: '1px solid var(--lt-border-subtle)',
                            }}
                          >
                            <span className="t-small">
                              <code>v{b.fromVersion}</code> ({b.fromTrack}) → <code>v{b.toVersion}</code> ·{' '}
                              <span className="t-meta">{new Date(b.createdAt).toLocaleString()}</span>
                            </span>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={upgrading}
                              onClick={() => void handleRollback(b.backupId)}
                            >
                              回滚至 v{b.fromVersion}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Explicit Cross-Track Isolation Notice */}
                    {otherTrackInfo && (
                      <details className="card card-pad">
                        <summary className="t-small" style={{ cursor: 'pointer', fontWeight: 600 }}>
                          发行分支隔离保护说明（查看另一分支：{otherTrackInfo.label}）
                        </summary>
                        <p className="t-meta" style={{ margin: '8px 0 10px' }}>
                          开源版（<code>youzi-ovo-create/dsh-leaderteam</code>）与闭源免费公开发行版（<code>youzi-ovo-create/dsh-leaderteam-releases</code>）严格各自独立检查更新，系统绝不会在未经您确认的情况下自动切换发行分支。
                        </p>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={checkingUpdate || upgrading}
                          onClick={() => {
                            setCrossTrackAck(false);
                            void handleCheckUpdate(otherTrackId);
                          }}
                        >
                          仅预览「{otherTrackInfo.shortLabel}」最新发布版本
                        </button>
                      </details>
                    )}
                  </div>

                  {/* Host Compatibility Matrix */}
                  {matrix && (
                    <div className="section">
                      <div className="section-head">
                        <div>
                          <span className="t-overline">自适应契约 · 告别强锁版</span>
                          <h2>DeepSeek Harness (DSH) 宿主版本兼容性列表</h2>
                        </div>
                      </div>
                      <div className="card card-pad">
                        <p className="t-small" style={{ marginTop: 0 }}>
                          支持声明范围：<code>{matrix.engineRange}</code> · 默认兼容策略：<code>{matrix.defaultPolicy}</code>（启动时动态核验安全门结构契约，宿主常规小版本更新可直接兼容运行）
                        </p>
                        <div style={{ overflowX: 'auto' }}>
                          <table className="table" style={{ width: '100%', fontSize: 13 }}>
                            <thead>
                              <tr>
                                <th>DSH 版本范围</th>
                                <th>适用形态</th>
                                <th>支持平台</th>
                                <th>兼容状态</th>
                                <th>说明</th>
                              </tr>
                            </thead>
                            <tbody>
                              {matrix.rows.map(row => (
                                <tr key={row.series}>
                                  <td>
                                    <code>{row.versionPattern}</code>
                                    <div className="t-meta">{row.series}</div>
                                  </td>
                                  <td>{row.surfaces.join(' / ')}</td>
                                  <td>{row.platforms.join(', ')}</td>
                                  <td>
                                    <span
                                      className={`badge sm ${
                                        row.status === 'VERIFIED'
                                          ? 'success'
                                          : row.productionAllowed
                                            ? 'outline'
                                            : 'danger'
                                      }`}
                                    >
                                      {row.statusLabel}
                                    </span>
                                  </td>
                                  <td className="t-meta">{row.notes}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {/* ==================== ABOUT ==================== */}
            {activeSub === 'about' && (
              <div className="section">
                <div className="row" style={{ gap: 16, marginBottom: 24 }}>
                  <HeluoxuMark size={44} />
                  <div className="col" style={{ gap: 2 }}>
                    <span className="t-display" style={{ fontSize: 24 }}>
                      Leader Team
                    </span>
                    <span className="t-meta">河洛 · 多代理工程协作 · 开源版</span>
                  </div>
                </div>
                <div className="card card-pad">
                  <dl className="kv" style={{ maxWidth: 520 }}>
                    <dt>版本</dt>
                    <dd className="mono">{bundle.capabilities.backendVersion}</dd>
                    <dt>后端工程线</dt>
                    <dd className="mono">{bundle.capabilities.backendLine}</dd>
                    <dt>公共契约</dt>
                    <dd className="mono">lt.public.v1 · {contractVer}</dd>
                    <dt>宿主形态</dt>
                    <dd>
                      {bundle.capabilities.features.liveSessionRpc
                        ? `DSH Web（同源实时 · ${bundle.capabilities.hostKind}）`
                        : `独立伴侣服务 (${bundle.capabilities.hostKind})`}
                    </dd>
                    <dt>开源许可证</dt>
                    <dd>Apache-2.0</dd>
                    <dt>Magpie 网关</dt>
                    <dd className="mono">
                      {bundle.gateway.version.license} · {bundle.gateway.version.current || bundle.gateway.version.pinned}
                    </dd>
                  </dl>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
