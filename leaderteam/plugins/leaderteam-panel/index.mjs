// Detachable Cordis host plugin for the in-DSH LeaderTeam visual console (`leaderteam-panel`).
import { runtime, registerRuntimePlugin } from '../../host/runtime.mjs';
import { registerPanelRoutes } from './panel-api.mjs';

export const name = 'leaderteam-panel';
export const inject = ['leaderteamReady'];

export function apply(ctx) {
  const rt = runtime();
  ctx.effect(() => registerRuntimePlugin('panel', { version: '2.2.0' }, rt), { label: 'leaderteam-panel registration' });
  ctx.inject(['connection'], c => {
    registerPanelRoutes(c, c.get('connection'), ctx, rt);
  });
}
