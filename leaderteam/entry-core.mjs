// DSH plugin row "leaderteam-core" (profile root): config, safety gate, team roles.
import path from 'node:path';
import { loadConfig } from './core/config.mjs';
import { isPluginActive, runtimeForTeam, runtime, bindRuntimeConfigFile, refreshUpstreamCatalog, effectiveRuntimeConfig } from './host/runtime.mjs';
import { syncUpstreamModelsToDshSettings } from './core/upstream-models.mjs';
import { onAgentCreated, onAgentPresetSelected, onAgentDisposed, onAgentStatus, onAgentError, onSessionEvent, onToolResult } from './host/roles.mjs';
import { bindHostImports } from './host/host-imports.mjs';
import { disposePlanning } from './host/planning.mjs';
import { frontierNeedsPlanning } from './core/frontier.mjs';
import { isAutonomousGovernance } from './core/governance-protocol.mjs';
import { isReadGrantOnlyMessage } from './core/gate-policy.mjs';
import { formatLeaderGovernanceContext, resolveHumanEscalationOnUserTurn } from './host/governance.mjs';
import { teamStore } from './host/runtime.mjs';
import { currentTaskSeq, userMessageTexts } from './host/roles.mjs';
import pkg from './package.json' with { type: 'json' };

let hostError;
let hostGate;
let hostSurface;
let hostCapabilities;
let hostLlm;
let hostConcurrency;
let hostTimerArchive;
try {
  bindHostImports();
  hostGate = await import('./host/final-gate.mjs');
  hostSurface = await import('./host/tool-surface.mjs');
  hostCapabilities = await import('./host/capability-tools.mjs');
  hostLlm = await import('@deepseek-ai/dsh-llm');
  hostConcurrency = await import('./host/concurrency.mjs');
  hostTimerArchive = await import('./host/timer-archive.mjs');
} catch (error) { hostError = error; }

export const name = 'leaderteam-core';
export const inject = ['tools', 'llm', 'agents'];

export function apply(ctx, config) {
  // Throw during activation so the Host rejects startup, instead of treating
  // a failed optional file import as an inactive row and continuing ungated.
  if (hostError) throw new Error('leaderteam: host imports unavailable; refusing to start without the safety gate', { cause: hostError });
  const { installFinalGate, Gate, ClosedGate } = hostGate;
  const rt = runtime();
  const configPath = config?.configPath ?? process.env.LEADERTEAM_CONFIG;
  if (!configPath) throw new Error('leaderteam-core: config.configPath (or LEADERTEAM_CONFIG) is required');
  bindRuntimeConfigFile(rt, configPath, loadConfig(configPath));
  rt.cordisCompositionMode = config?.modular === true;
  rt.plugins = { scheduler: null, consensus: null, timerArchive: null, panel: null };
  rt.surface = config?.surface === 'headless' ? 'headless' : 'desktop';
  const home = process.env.DSH_HOME ?? ctx.get('profileContext')?.home;
  if (!rt.config.storage.root && !home) throw new Error('leaderteam-core: cannot locate DSH_HOME for team storage');
  rt.storageRoot = rt.config.storage.root ?? path.join(home, 'leaderteam');
  rt.llm = ctx.llm;
  rt.logger = ctx.logger;
  rt.hostAgents = ctx.agents ?? null;
  rt.liveProcessMemberIds = new Set();
  rt.planningDisposed = false;
  rt.currentPlanningTaskSeq = teamId => currentTaskSeq(ctx, teamId);
  rt.createUserMessage = hostLlm?.createUserMessage ?? null;
  if (!rt.cordisCompositionMode && rt.config.plugins?.scheduler !== false) {
    hostConcurrency.ensureScheduler(rt);
  }
  if (!rt.cordisCompositionMode && rt.config.plugins?.timerArchive !== false) {
    hostTimerArchive.ensurePlanArchive(rt, null);
  }
  rt.formatLeaderContext = teamId => {
    const sections = [];
    const teamRt = runtimeForTeam(teamId);
    if (isAutonomousGovernance(teamRt.config)) {
      const g = formatLeaderGovernanceContext(teamStore(teamId), currentTaskSeq(ctx, teamId));
      if (g) sections.push(g);
    }
    if (isPluginActive(teamRt, 'scheduler')) {
      const c = hostConcurrency.formatLeaderConcurrencyContext(ctx, teamId);
      if (c) sections.push(c);
    }
    if (isPluginActive(teamRt, 'timerArchive')) {
      const t = hostTimerArchive.formatLeaderTimerContext(ctx, teamId, null, teamRt);
      if (t) sections.push(t);
    }
    return sections.join('\n\n');
  };
  rt.onLeaderSessionReady = (hookCtx, teamId, cwd) => {
    if ((!rt.cordisCompositionMode || rt.plugins.timerArchive) && rt.config.plugins?.timerArchive !== false) {
      hostTimerArchive.ensureTeamTimerState(hookCtx, teamId, cwd, runtimeForTeam(teamId));
      hostTimerArchive.ensurePlanArchive(runtimeForTeam(teamId), cwd);
    }
  };
  rt.onMemberTerminalStatus = (teamId, taskSeq) => {
    if ((!rt.cordisCompositionMode || rt.plugins.timerArchive) && rt.config.plugins?.timerArchive !== false) {
      hostTimerArchive.syncArchivedMemberStatuses(teamId, taskSeq, runtimeForTeam(teamId));
    }
  };
  rt.onLeaderUserMessage = (hookCtx, teamId) => {
    const teamRt = runtimeForTeam(teamId), actor = rt.actors.get(teamId);
    if (isAutonomousGovernance(teamRt.config)) {
      const latestMsg = userMessageTexts(hookCtx, teamId).at(-1) ?? '';
      if (latestMsg && !isReadGrantOnlyMessage(latestMsg)) {
        void resolveHumanEscalationOnUserTurn({
          ctx: hookCtx,
          rt: teamRt,
          store: teamStore(teamId),
          leaderAgent: actor?.agent ?? null,
          taskSeq: currentTaskSeq(hookCtx, teamId),
          userText: latestMsg,
        }).catch(() => {});
      }
    }
    if (teamRt.config.team.rollingPlanning && actor && isPluginActive(teamRt, 'consensus')) {
      rt.recoverExecutionReviews?.(actor, currentTaskSeq(hookCtx, teamId));
    }
    if ((!rt.cordisCompositionMode || rt.plugins.timerArchive) && rt.config.plugins?.timerArchive !== false) {
      try { hostTimerArchive.touchTeamTimer(hookCtx, teamId, null, runtimeForTeam(teamId)); } catch {}
    }
    if ((!rt.cordisCompositionMode || rt.plugins.scheduler) && rt.config.plugins?.scheduler !== false) {
      const res = hostConcurrency.syncTeamConcurrency(hookCtx, teamId, rt);
      if (res.raised) hostConcurrency.maybeNotifyLeaderScaleUp(hookCtx, teamId, { userCapRaised: true });
    }
  };
  rt.onLeaderTurnEnd = (hookCtx, teamId) => {
    if ((!rt.cordisCompositionMode || rt.plugins.timerArchive) && rt.config.plugins?.timerArchive !== false) {
      try { hostTimerArchive.touchTeamTimer(hookCtx, teamId, null, runtimeForTeam(teamId)); } catch {}
    }
    if ((!rt.cordisCompositionMode || rt.plugins.scheduler) && rt.config.plugins?.scheduler !== false) {
      try { hostConcurrency.onLeaderTurnCompleted(hookCtx, teamId); } catch {}
    }
  };
  rt.onLeaderIdle = (hookCtx, teamId) => {
    if (runtimeForTeam(teamId).config.team.rollingPlanning && frontierNeedsPlanning(teamStore(teamId), currentTaskSeq(hookCtx, teamId))) return false;
    if (isPluginActive(runtimeForTeam(teamId), "scheduler")) {
    try { return hostConcurrency.handleLeaderIdle(hookCtx, teamId); } catch { return false; }
    }
    return false;
  };
  rt.reserveMemberActivation = (teamId, member) => isPluginActive(runtimeForTeam(teamId), 'scheduler') ? hostConcurrency.reserveTeamDispatch(ctx, teamId, { id: member.childId, name: member.name, taskSeq: member.taskSeq, profile: member.profile }) : null;
  rt.activationCapacity = teamId => isPluginActive(runtimeForTeam(teamId), 'scheduler') ? hostConcurrency.evaluateTeamConcurrency(ctx, teamId) : null;
  rt.activationLimit = teamId => isPluginActive(runtimeForTeam(teamId), 'scheduler') ? hostConcurrency.evaluateTeamConcurrency(ctx, teamId).controls.user_max_concurrent : runtimeForTeam(teamId).config.team.maxActiveMembers;
  installFinalGate(pkg.leaderteam.supportedCoreVersions);
  rt.gate = new Gate(ctx);
  hostSurface.installToolSurface(agent => agent?.session ? rt.gate.actorFor(agent) : null);
  hostCapabilities.registerCapabilityTools(ctx);
  ctx.on('agent/created', event => onAgentCreated(ctx, event));
  ctx.on('agent-preset/selected', sessionId => {
    // Model defaults can append a selection event. Wait for the preset append to finish.
    queueMicrotask(() => {
      try { onAgentPresetSelected(ctx, sessionId); }
      catch (error) { ctx.logger.warn(`LeaderTeam preset synchronization: ${String(error)}`); }
    });
  });
  ctx.on('agent/disposed', event => onAgentDisposed(event));
  ctx.on('agent/status', event => onAgentStatus(ctx, event));
  ctx.on('agent/error', event => onAgentError(ctx, event));
  ctx.on('session/event', (session, event) => onSessionEvent(ctx, session, event));
  ctx.on('tools/result', (exec, result) => onToolResult(exec, result));
  if (!rt.cordisCompositionMode && rt.config.plugins?.scheduler !== false) {
    ctx.effect(() => hostConcurrency.startConcurrencyWatchers(ctx), { label: 'leaderteam-core concurrency' });
  }
  ctx.effect(() => () => { disposePlanning(rt); rt.gate = new ClosedGate(); rt.startupReady = null; rt.hostAgents = null; rt.liveProcessMemberIds = null; }, { label: 'leaderteam-core gate' });
  const ready = Object.freeze({ coreVersion: pkg.version, modular: rt.cordisCompositionMode });
  rt.startupReady = ready;
  ctx.provide('leaderteamReady', ready);
  // Asynchronously probe upstream `/v1/models` on startup so live `contextWindow` / `maxTokens` enrich runtime config and DSH settings.
  queueMicrotask(() => {
    refreshUpstreamCatalog(ctx, rt, { force: true, probeEndpoints: true }).then(cat => {
      if (!cat || rt.planningDisposed) return;
      const eff = effectiveRuntimeConfig(rt);
      if (!eff) return;
      const defaultProvider = eff.magpie?.provider ?? 'magpie';
      const modelsToSync = Object.entries(eff.models ?? {}).map(([route, spec]) => ({
        route,
        provider: spec.provider ?? defaultProvider,
        upstreamModel: spec.upstreamModel ?? route,
        efforts: spec.efforts,
        vision: spec.vision,
        contextWindow: spec.contextWindow,
        maxTokens: spec.maxTokens,
      }));
      return syncUpstreamModelsToDshSettings(ctx, modelsToSync, defaultProvider);
    }).catch(() => {});
  });
  ctx.logger?.info?.(`leaderteam: core ${pkg.version} active (surface=${rt.surface}, storage=${rt.storageRoot})`);
}
