import React, { useState } from 'react';
import { HeluoxuMark } from './HeluoxuMark';
import { Icon, type IconName } from './Icon';
import { formatCny, type HydratedBundle } from '../lib/api';

export type NavViewId = 'workbench' | 'teams' | 'connect' | 'hengzhang' | 'settings';

export interface NavItemDef {
  id: NavViewId;
  label: string;
  icon: IconName;
  shortcut: string;
  visible: boolean;
}

export function Splitter({
  which,
  hidden,
}: {
  which: 'ctx' | 'ins';
  hidden?: boolean;
}) {
  const [dragging, setDragging] = useState(false);

  if (hidden) return null;

  const varName = which === 'ctx' ? '--lt-context-w' : '--lt-inspector-w';
  const storageKey = which === 'ctx' ? 'lt.pane.contextW' : 'lt.pane.inspectorW';
  const min = which === 'ctx' ? 220 : 300;
  const max = which === 'ctx' ? 420 : 520;
  const fallback = which === 'ctx' ? 280 : 344;

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const root = document.documentElement;
    const startX = e.clientX;
    const start = parseInt(getComputedStyle(root).getPropertyValue(varName), 10) || fallback;
    setDragging(true);
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const nextW = Math.max(min, Math.min(max, which === 'ctx' ? start + dx : start - dx));
      root.style.setProperty(varName, `${nextW}px`);
      try {
        localStorage.setItem(storageKey, String(nextW));
      } catch {}
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onDoubleClick() {
    document.documentElement.style.removeProperty(varName);
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  }

  return (
    <div
      className={dragging ? 'splitter dragging' : 'splitter'}
      data-split={which}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="vertical"
      aria-label={which === 'ctx' ? '调整左侧上下文栏宽度' : '调整右侧检视栏宽度'}
    />
  );
}

export function restoreSavedPaneWidths(): void {
  if (typeof document === 'undefined') return;
  try {
    const ctxW = parseInt(localStorage.getItem('lt.pane.contextW') || '', 10);
    if (Number.isFinite(ctxW) && ctxW >= 220 && ctxW <= 420) {
      document.documentElement.style.setProperty('--lt-context-w', `${ctxW}px`);
    }
    const insW = parseInt(localStorage.getItem('lt.pane.inspectorW') || '', 10);
    if (Number.isFinite(insW) && insW >= 300 && insW <= 520) {
      document.documentElement.style.setProperty('--lt-inspector-w', `${insW}px`);
    }
  } catch {}
}

export function Rail({
  items,
  activeView,
  hasRunningSession,
  hasEscalation,
  dshFrontendUrl,
  onNavigate,
  onOpenPalette,
  onOpenThemeMenu,
}: {
  items: NavItemDef[];
  activeView: NavViewId;
  hasRunningSession: boolean;
  hasEscalation: boolean;
  dshFrontendUrl: string | null;
  onNavigate: (view: NavViewId, sub?: string) => void;
  onOpenPalette: () => void;
  onOpenThemeMenu: (rect: DOMRect) => void;
}) {
  return (
    <nav className="rail" aria-label="主导航">
      <button
        type="button"
        className="rail-brand"
        onClick={onOpenPalette}
        title="河洛 · Leader Team（Ctrl+K 命令面板）"
      >
        <HeluoxuMark size={24} />
      </button>

      {items
        .filter(n => n.visible && n.id !== 'settings')
        .map(n => (
          <button
            key={n.id}
            type="button"
            className="rail-item"
            aria-current={activeView === n.id ? 'page' : undefined}
            title={`${n.label}（Ctrl+${n.shortcut}）`}
            onClick={() => onNavigate(n.id)}
          >
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.id === 'workbench' && hasRunningSession && (
              <i className="rail-pip" aria-label="有运行中的回合" />
            )}
            {n.id === 'teams' && hasEscalation && (
              <i className="rail-pip" style={{ background: 'var(--lt-seal)' }} aria-label="有待人工裁决的团队" />
            )}
          </button>
        ))}

      <div className="rail-spacer" />

      {dshFrontendUrl && (
        <a
          className="rail-item"
          href={dshFrontendUrl}
          title="切换到 DSH 原生前端（共享运行时与活跃团队，零中断）"
        >
          <Icon name="swap" />
          <span>DSH</span>
        </a>
      )}

      <button
        type="button"
        className="rail-item"
        title="快速切换主题与密度"
        onClick={e => onOpenThemeMenu(e.currentTarget.getBoundingClientRect())}
      >
        <Icon name="contrast" />
        <span>主题</span>
      </button>

      <button
        type="button"
        className="rail-item"
        aria-current={activeView === 'settings' ? 'page' : undefined}
        title="设置（Ctrl+9）"
        onClick={() => onNavigate('settings')}
      >
        <Icon name="sliders" />
        <span>设置</span>
      </button>
    </nav>
  );
}

export function StatusBar({
  bundle,
  todayCostCny,
  todayUnknownCount,
  onNavigate,
  onOpenPalette,
}: {
  bundle: HydratedBundle;
  todayCostCny: number | null;
  todayUnknownCount: number;
  onNavigate: (view: NavViewId, sub?: string) => void;
  onOpenPalette: () => void;
}) {
  const feats = bundle.capabilities.features;
  const live = feats.liveSessionRpc;
  const gw = bundle.gateway;
  const rt = bundle.runtime;
  const runningTeamsCount = (rt.teams || []).filter(t => t.status === 'active' || t.status === 'paused' || t.status === 'waiting_user').length;

  const sortedWindows = [...(rt.requestWindows || [])].sort((a, b) => {
    const pa = a.limit5h ? a.used5h / a.limit5h : 0;
    const pb = b.limit5h ? b.used5h / b.limit5h : 0;
    return pb - pa;
  });
  const topWin = sortedWindows[0] || null;
  const winPct = topWin?.limit5h ? Math.round((topWin.used5h / topWin.limit5h) * 100) : null;

  const gwDot = gw.state === 'running' ? 'ok' : gw.state === 'error' ? 'err' : 'warn';
  const gwLabel =
    gw.state === 'running'
      ? '运行中'
      : gw.state === 'stopped'
        ? '已停止'
        : gw.state === 'not_installed'
          ? '未安装'
          : gw.state;

  const contractVersion = feats.inSessionDualMode ? '1.1.0' : '1.0.1';

  return (
    <footer className="status" aria-label="系统遥测状态栏">
      <span
        className="status-item"
        title={live ? 'DSH Web 同源宿主 · 实时会话 RPC 可用' : '独立伴侣服务 · 历史浏览与配置管理'}
      >
        <i className={`dot ${live ? 'ok' : 'idle'}`} />
        {live ? 'DSH Web · 实时' : '独立伴侣 · 历史与配置'}
      </span>

      {(feats.magpieGateway || feats.directProviders) && (
        <>
          <i className="status-sep" />
          <button
            type="button"
            className="status-item"
            onClick={() => onNavigate('connect', 'gateway')}
            title="点击管理 Magpie 网关"
          >
            <i className={`dot ${gwDot}`} />
            Magpie {gwLabel}
            {gw.health.latencyMs !== null && (
              <>
                {' · '}
                <span className="num">{gw.health.latencyMs} ms</span>
              </>
            )}
          </button>
        </>
      )}

      {feats.teamObservability && (
        <>
          <i className="status-sep" />
          <button
            type="button"
            className="status-item"
            onClick={() => onNavigate('teams')}
            title="团队与治理视图"
          >
            <Icon name="network" className="icon-14" />
            <span className="num">
              {runningTeamsCount > 0 ? `${runningTeamsCount} 个团队运行中` : '无运行中团队'}
            </span>
          </button>
        </>
      )}

      {feats.schedulerTelemetry && (
        <>
          <i className="status-sep" />
          <button
            type="button"
            className="status-item"
            onClick={() => onNavigate('teams')}
            title="弹性并发：活跃执行成员 / 有效上限"
          >
            <Icon name="gauge" className="icon-14" />
            并发{' '}
            <span className="num">
              {rt.scheduler.activeExecutionMembers}/{rt.scheduler.effectiveCap ?? rt.scheduler.maxActiveMembers}
            </span>
          </button>
        </>
      )}

      {feats.schedulerTelemetry && topWin && (
        <>
          <i className="status-sep" />
          <button
            type="button"
            className="status-item"
            onClick={() => onNavigate('teams')}
            title="5 小时滚动请求窗口（最紧张供应商）"
            style={winPct !== null && winPct >= 70 ? { color: 'var(--lt-warning)' } : undefined}
          >
            <Icon name="clock" className="icon-14" />
            {topWin.provider}{' '}
            <span className="num">
              {topWin.used5h}/{topWin.limit5h ?? '—'}
            </span>
          </button>
        </>
      )}

      {rt.power && rt.power.enabled && (
        <>
          <i className="status-sep" />
          <span
            className="status-item"
            style={rt.power.latched ? { color: 'var(--lt-warning)' } : undefined}
            title="电源感知安全收尾护栏"
          >
            <Icon name="battery" className="icon-14" />
            {rt.power.batteryPct !== null ? (
              <>
                <span className="num">{rt.power.batteryPct}%</span> {rt.power.onBattery ? '电池' : '接电'}
              </>
            ) : (
              '接电常驻'
            )}
          </span>
        </>
      )}

      {feats.usageAnalytics && (
        <>
          <i className="status-sep" />
          <button
            type="button"
            className="status-item"
            onClick={() => onNavigate('hengzhang')}
            title="衡账：用量与成本分析"
          >
            <Icon name="ledger" className="icon-14" />
            {bundle.usageStatus.enabled ? (
              <>
                今日{' '}
                {todayCostCny !== null ? <span className="num">{formatCny(todayCostCny)}</span> : <span>就绪</span>}
                {todayUnknownCount > 0 && (
                  <>
                    {' · 未知 '}
                    <span className="num" style={{ color: 'var(--lt-warning)' }}>
                      {todayUnknownCount}
                    </span>
                  </>
                )}
              </>
            ) : (
              '衡账已关闭'
            )}
          </button>
        </>
      )}

      <span className="status-spacer" />

      <span className="status-item mono" title="公共接口契约">
        lt.public.v1 · {contractVersion}
      </span>
      <i className="status-sep" />
      <button type="button" className="status-item" onClick={onOpenPalette} title="打开命令面板">
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </button>
    </footer>
  );
}

export function StageHead({
  title,
  overline,
  leading,
  right,
}: {
  title: React.ReactNode;
  overline?: string;
  leading?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="stage-head">
      {leading}
      <div className="view-title">
        {overline && <span className="t-overline">{overline}</span>}
        <h1 className="t-title">{title}</h1>
      </div>
      <span className="grow" />
      {right}
    </div>
  );
}
