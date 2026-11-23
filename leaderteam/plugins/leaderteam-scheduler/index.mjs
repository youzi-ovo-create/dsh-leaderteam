// Detachable Cordis plugin: elastic device-aware concurrency scheduler (`leaderteam-scheduler`).
import { bindHostImports } from '../../host/host-imports.mjs';
import { runtime, registerRuntimePlugin } from '../../host/runtime.mjs';

let hostError;
let hostConcurrency;
try {
  bindHostImports();
  hostConcurrency = await import('../../host/concurrency.mjs');
} catch (error) { hostError = error; }

export const name = 'leaderteam-scheduler';
export const inject = ['leaderteamReady', 'agents'];

export function apply(ctx) {
  if (hostError) throw new Error('leaderteam-scheduler: host imports unavailable', { cause: hostError });
  const rt = runtime();
  if (rt.config?.plugins?.scheduler !== false) {
    hostConcurrency.ensureScheduler(rt);
    ctx.effect(() => hostConcurrency.startConcurrencyWatchers(ctx), { label: 'leaderteam-scheduler watchers' });
  }
  ctx.effect(() => registerRuntimePlugin('scheduler', { version: '2.1.0' }, rt), { label: 'leaderteam-scheduler registration' });
}
