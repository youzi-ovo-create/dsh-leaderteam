// Detachable Cordis plugin: symmetric accountable consensus & arbiter (`leaderteam-consensus`).
import { runtime, registerRuntimePlugin } from '../../host/runtime.mjs';

export const name = 'leaderteam-consensus';
export const inject = ['leaderteamReady'];

export function apply(ctx) {
  const rt = runtime();
  ctx.effect(() => registerRuntimePlugin('consensus', { version: '2.1.0' }, rt), { label: 'leaderteam-consensus registration' });
}
