// Retain the official required entry id "tool-executor-native" in compositions.
// Its dependency makes a missing/failed LeaderTeam core fatal during Host audit.
import { bindHostImports } from './host/host-imports.mjs';
import { runtime } from './host/runtime.mjs';
let hostError;
let executor;
try {
  bindHostImports();
  executor = await import('@deepseek-ai/dsh-tool-executor-native');
} catch (error) { hostError = error; }
export const name = 'leaderteam-native-executor';
export const inject = [...(executor?.inject ?? ['tools']), 'leaderteamReady'];
export function apply(ctx, config) {
  if (hostError) throw new Error('leaderteam: host imports unavailable; native executor cannot start', { cause: hostError });
  const rt = runtime();
  if (!rt.config || !rt.gate || !rt.startupReady || ctx.get('leaderteamReady') !== rt.startupReady) {
    throw new Error('leaderteam: safety gate is not ready; native execution cannot start');
  }
  return executor.apply(ctx, config);
}
