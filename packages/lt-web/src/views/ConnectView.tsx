import React, { useState } from 'react';
import type { HydratedBundle } from '../lib/api';
import { Icon, type IconName } from '../components/Icon';
import { Splitter } from '../components/AppShell';
import { ProvidersView } from './ProvidersView';
import { ModelsRolesView } from './ModelsRolesView';

export type ConnectStepId = 'gateway' | 'providers' | 'models' | 'roles';

export function ConnectView({
  bundle,
  initialSub,
  ctxOpen = true,
  onToggleCtx,
  onRefreshBundle,
  onNavigateSub,
  onNotify,
}: {
  bundle: HydratedBundle;
  initialSub?: string | null;
  ctxOpen?: boolean;
  onToggleCtx?: () => void;
  onRefreshBundle: () => Promise<void>;
  onNavigateSub?: (sub: ConnectStepId) => void;
  onNotify?: (message: string, icon?: IconName) => void;
}) {
  const feats = bundle.capabilities.features;
  const [localStep, setLocalStep] = useState<ConnectStepId>(
    initialSub === 'gateway' || initialSub === 'providers' || initialSub === 'models' || initialSub === 'roles'
      ? initialSub
      : feats.magpieGateway || feats.directProviders
        ? 'providers'
        : 'models',
  );
  const [saveTarget, setSaveTarget] = useState<'local' | 'base'>('local');

  const activeStep: ConnectStepId =
    initialSub === 'gateway' || initialSub === 'providers' || initialSub === 'models' || initialSub === 'roles'
      ? initialSub
      : localStep;

  function goStep(s: ConnectStepId) {
    setLocalStep(s);
    if (onNavigateSub) onNavigateSub(s);
  }

  const gw = bundle.gateway;
  const totalCreds = bundle.providers.reduce((sum, p) => sum + p.credentials.length, 0);
  const authReqCount = bundle.providers.filter(p => p.status === 'auth_required').length;
  const inPoolCount = bundle.models.filter(m => m.inModelPool).length;
  const execPoolCount = bundle.runtime.modelPool.executionPool.length;
  const boundRolesCount = bundle.capabilities.supportedRoles.filter(
    r => Boolean(bundle.runtime.roleAssignments[r.roleId]?.route),
  ).length;
  const localRoleOverridesCount = bundle.runtime.localOverrides?.roles?.length || 0;

  const allSteps: Array<{
    id: ConnectStepId;
    title: string;
    summary: string;
    state: 'done' | 'attn' | '';
    visible: boolean;
  }> = [
    {
      id: 'gateway',
      title: '网关',
      summary:
        gw.mode === 'disabled'
          ? '已停用 · 仅直连模式'
          : `Magpie ${gw.mode === 'managed' ? '托管' : '外部'} · ${gw.state === 'running' ? '运行中' : gw.state}${gw.version.current ? ` · v${gw.version.current}` : ''}`,
      state: gw.state === 'running' || gw.mode === 'disabled' ? 'done' : 'attn',
      visible: feats.magpieGateway,
    },
    {
      id: 'providers',
      title: '供应商与凭据',
      summary: `${bundle.providers.length} 个供应商 · ${totalCreds} 份凭据${authReqCount > 0 ? ` · ${authReqCount} 项待授权` : ''}`,
      state: bundle.providers.length > 0 && authReqCount === 0 ? 'done' : 'attn',
      visible: feats.magpieGateway || feats.directProviders,
    },
    {
      id: 'models',
      title: '模型目录与执行池',
      summary: `${bundle.models.length} 个模型 · 池内 ${inPoolCount} · 执行池 ${execPoolCount}`,
      state: execPoolCount > 0 ? 'done' : '',
      visible: feats.modelPoolWrite || feats.roleConfigWrite,
    },
    {
      id: 'roles',
      title: '角色路由',
      summary: `${boundRolesCount} / ${bundle.capabilities.supportedRoles.length} 已绑定${localRoleOverridesCount > 0 ? ` · ${localRoleOverridesCount} 项本机覆盖` : ''}`,
      state: boundRolesCount === bundle.capabilities.supportedRoles.length && boundRolesCount > 0 ? 'done' : '',
      visible: feats.roleConfigWrite,
    },
  ];
  const steps = allSteps.filter(s => s.visible);

  return (
    <div className="body" style={{ flex: 1 }}>
      <aside
        className={`pane pane-context${ctxOpen ? '' : ' is-floating-hidden'}`}
        hidden={!ctxOpen}
        aria-label="模型接入步骤导航"
      >
        <div className="pane-head">
          <span className="t-subhead" style={{ fontSize: 14 }}>
            模型接入
          </span>
        </div>
        <div className="pane-body">
          <ol className="stepper">
            {steps.map((s, idx) => {
              const isCurrent = activeStep === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`step ${s.state}`}
                    aria-current={isCurrent ? 'step' : undefined}
                    onClick={() => goStep(s.id)}
                  >
                    <span className="step-node">
                      {s.state === 'done' && !isCurrent ? <Icon name="check" className="icon-14" /> : idx + 1}
                    </span>
                    <span className="col" style={{ gap: 0 }}>
                      <span className="step-title">{s.title}</span>
                      <span className="step-sum">{s.summary}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="pane-section hairline-top">
            <div className="t-overline" style={{ marginBottom: 8 }}>
              配置写入层
            </div>
            <div className="seg seg-sm" style={{ width: '100%' }}>
              <button
                type="button"
                style={{ flex: 1 }}
                aria-pressed={saveTarget === 'local'}
                onClick={() => setSaveTarget('local')}
              >
                本机覆盖
              </button>
              <button
                type="button"
                style={{ flex: 1 }}
                aria-pressed={saveTarget === 'base'}
                onClick={() => setSaveTarget('base')}
              >
                基础配置
              </button>
            </div>
            <div className="hint mono" style={{ marginTop: 6 }}>
              {saveTarget === 'local' ? 'leaderteam.local.json' : 'leaderteam.config.json'}
            </div>
          </div>
        </div>
      </aside>

      <Splitter which="ctx" hidden={!ctxOpen} />

      <main className="stage">
        {activeStep === 'gateway' || activeStep === 'providers' ? (
          <ProvidersView
            bundle={bundle}
            step={activeStep}
            ctxOpen={ctxOpen}
            onToggleCtx={onToggleCtx}
            onRefreshBundle={onRefreshBundle}
            onNextStep={() => goStep(activeStep === 'gateway' ? 'providers' : 'models')}
            onNotify={onNotify}
          />
        ) : (
          <ModelsRolesView
            bundle={bundle}
            step={activeStep}
            saveTarget={saveTarget}
            onChangeSaveTarget={setSaveTarget}
            ctxOpen={ctxOpen}
            onToggleCtx={onToggleCtx}
            onRefreshBundle={onRefreshBundle}
            onNextStep={activeStep === 'models' ? () => goStep('roles') : undefined}
            onNotify={onNotify}
          />
        )}
      </main>
    </div>
  );
}
