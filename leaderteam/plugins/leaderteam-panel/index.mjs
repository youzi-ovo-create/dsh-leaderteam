// Detachable Cordis host plugin for the in-DSH LeaderTeam visual console (`leaderteam-panel` / `dsh-leaderteam`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime, registerRuntimePlugin } from '../../host/runtime.mjs';
import { detectLegacyProfilePatchConflicts } from '../../core/legacy-patch-guard.mjs';
import { registerPanelRoutes } from './panel-api.mjs';
import pkg from '../../package.json' with { type: 'json' };

export const name = 'leaderteam-panel';
export const inject = ['leaderteamReady'];

class LegacyPatchConflictGate {
  constructor(previousGate, reason) {
    this.previousGate = previousGate;
    this.reason = reason;
  }
  actorFor(agent) {
    if (typeof this.previousGate?.actorFor === 'function') {
      try {
        const hit = this.previousGate.actorFor(agent);
        if (hit) return hit;
      } catch {}
    }
    return agent?.session ? { role: 'unknown', teamId: agent.id } : null;
  }
  checkHardRules() {
    return { rule: 'legacy-profile-patch-conflict', reason: this.reason };
  }
  async decide() {
    return { decision: 'deny', by: 'legacy-profile-patch-conflict', reason: this.reason };
  }
}

export function assertNoLegacyDesktopPatchOverride(ctx, rt = runtime(), options = {}) {
  const expectedVersion = options.expectedVersion ?? pkg.version;
  const bundleRoot = options.bundleRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const activeCoreVersion = ctx?.leaderteamReady?.coreVersion ?? rt?.startupReady?.coreVersion ?? null;
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? ctx?.get?.('profileContext')?.home ?? null;
  const bundleConflicts = dshHome
    ? detectLegacyProfilePatchConflicts({ dshHome, currentBundleRoot: bundleRoot, fsImpl: options.fsImpl }).filter(c => c.bundleInstalled)
    : [];

  if ((activeCoreVersion && activeCoreVersion !== expectedVersion) || bundleConflicts.length > 0) {
    const filesHint = bundleConflicts.map(c => c.patchFile).join(', ');
    const reason = `Legacy LeaderTeam profile patch override detected (${activeCoreVersion && activeCoreVersion !== expectedVersion ? `active core=${activeCoreVersion}, expected=${expectedVersion}` : 'cordis.patch.yml overrides dsh-leaderteam bundle'}${filesHint ? `; file=${filesHint}` : ''}). Refusing mixed/stale execution: run "npx lt-doctor --clean-legacy-patch" (or scripts/uninstall-desktop.ps1) and restart DeepSeek Harness.`;
    if (rt) {
      rt.gate = new LegacyPatchConflictGate(rt.gate, reason);
      rt.startupReady = null;
    }
    throw new Error(reason);
  }
}

export function apply(ctx) {
  const rt = runtime();
  assertNoLegacyDesktopPatchOverride(ctx, rt);
  ctx.effect(() => registerRuntimePlugin('panel', { version: pkg.version }, rt), { label: 'leaderteam-panel registration' });
  ctx.inject(['connection'], c => {
    registerPanelRoutes(c, c.get('connection'), ctx, rt);
  });
}
