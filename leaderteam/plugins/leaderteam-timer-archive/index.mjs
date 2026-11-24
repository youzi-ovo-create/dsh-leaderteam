// Detachable Cordis plugin: engineering timer & fixed external plan archive (`leaderteam-timer-archive`).
import { bindHostImports } from '../../host/host-imports.mjs';
import { runtime, registerRuntimePlugin } from '../../host/runtime.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../../core/plan-archive.mjs';

let hostError;
try {
  bindHostImports();
  await import('../../host/timer-archive.mjs');
} catch (error) { hostError = error; }

export const name = 'leaderteam-timer-archive';
export const inject = ['leaderteamReady'];

export function apply(ctx) {
  if (hostError) throw new Error('leaderteam-timer-archive: host imports unavailable', { cause: hostError });
  const rt = runtime();
  if (rt.config?.plugins?.timerArchive !== false && rt.config?.planArchive?.enabled !== false && rt.storageRoot) {
    const archiveRoot = resolvePlanArchiveRoot({ config: rt.config, storageRoot: rt.storageRoot, workspaceRoot: null });
    rt.planArchiveStore = new PlanArchiveStore(archiveRoot);
  }
  ctx.effect(() => registerRuntimePlugin('timerArchive', { version: '2.2.0' }, rt), { label: 'leaderteam-timer-archive registration' });
}
