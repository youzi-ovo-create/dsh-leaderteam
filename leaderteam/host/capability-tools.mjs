import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runtime, teamStore, syncRuntimeConfig, runtimeForTeam } from './runtime.mjs';
import { resolveActor } from './roles.mjs';
import { registeredDefinitions } from './tool-surface.mjs';
import { toolCatalog } from '../core/tool-policy.mjs';
import { discoverSkills, loadSkill } from '../core/skills.mjs';

const output = { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] };
function actorOf(ctx, exec) {
  const rt = runtime();
  syncRuntimeConfig(rt);
  const actor = rt.actors.get(exec.agent?.id) ?? (exec.agent && resolveActor(ctx, exec.agent));
  if (!actor || !['leader', 'member'].includes(actor.role)) throw new Error('capability tools require a registered team agent');
  return { rt: runtimeForTeam(actor.teamId), actor };
}
export function skillOptions(actor, cfg) {
  return { workspace: actor.cwd, globalRefRoots: cfg.paths.globalRefRoots, skillRoots: [path.join(actor.cwd, '.agents/skills'), path.join(actor.cwd, '.leaderteam/skills'), ...(cfg.skills?.roots ?? [])] };
}
export async function profileDefinitions(ctx, profile) {
  const presets = ctx.get('agentPresets');
  if (typeof presets?.acquireScope !== 'function') throw new Error('the verified preset registry scope reader is unavailable');
  const lease = await presets.acquireScope(profile.preset);
  try { return ctx.tools.definitions(lease.key); }
  finally { await lease[Symbol.asyncDispose](); }
}

export function registerCapabilityTools(ctx) {
  const reg = def => ctx.effect(() => ctx.tools.register(defineTool(def)), { label: def.name });
  reg({
    name: 'team_tools',
    description: 'Discover authorized tool names and short summaries without loading their full schemas. Load explicitly deferred tools for the NEXT model step; loading never expands task permissions.',
    parameters: {
      action: { type: 'string', enum: ['list', 'load'], required: true },
      profile: { type: 'string', description: 'Leader only: member profile whose task tools you are choosing.' },
      names: { type: 'array', items: { type: 'string' }, description: 'Exact authorized tool names to load.' },
    }, output,
    async execute(args, exec) {
      const { rt, actor } = actorOf(ctx, exec);
      const definitions = registeredDefinitions(ctx.tools, exec.agent);
      if (args.action === 'list') {
        if (actor.role === 'leader' && args.profile) {
          if (!rt.config.derived.memberProfiles.includes(args.profile)) throw new Error('unknown member profile');
          const actual = await profileDefinitions(ctx, rt.config.profiles[args.profile]);
          return { profile: args.profile, tools: toolCatalog(rt.config, args.profile, actual) };
        }
        const byName = new Map(definitions.map(d => [d.name, d]));
        return { tools: actor.allowedTools.map(name => ({ name, loaded: actor.loadedTools.includes(name), description: String(byName.get(name)?.description ?? '').slice(0, 240) })) };
      }
      if (args.action !== 'load' || !Array.isArray(args.names) || !args.names.length) throw new Error('load requires names');
      const registered = new Set(definitions.map(d => d.name));
      for (const name of args.names) {
        if (actor.shellFailure && rt.config.gate.shellTools.includes(name)) throw new Error('OS sandbox initialization failed; shell retries are disabled for this member. Report the workspace problem to the leader.');
        if (!actor.allowedTools.includes(name)) throw new Error(`tool is not authorized for this task: ${name}`);
        if (!registered.has(name)) throw new Error(`authorized tool is not registered in this session: ${name}`);
      }
      const loaded = [...new Set([...actor.loadedTools, ...args.names])];
      if (actor.role === 'member') teamStore(actor.teamId).setMemberTools(actor.agentId, loaded);
      actor.loadedTools = loaded;
      return { loaded: args.names, effective: 'next model step', permissionsChanged: false };
    },
  });
  reg({
    name: 'team_skills',
    description: 'List skill names and summaries without adding their bodies to context, or read one skill. A member can read only skills selected in its dispatch; selected skill instructions are preserved across restart.',
    parameters: {
      action: { type: 'string', enum: ['list', 'read'], required: true },
      id: { type: 'string', description: 'Exact skill id from list.' },
    }, output,
    async execute(args, exec) {
      const { rt, actor } = actorOf(ctx, exec);
      const catalog = actor.role === 'leader' ? discoverSkills(skillOptions(actor, rt.config)) : actor.skills;
      if (args.action === 'list') return { skills: catalog.map(({ id, name, description, path: file }) => ({ id, name, description, path: file })) };
      if (args.action !== 'read' || typeof args.id !== 'string') throw new Error('read requires a skill id');
      if (actor.role === 'member') {
        const skill = actor.skills.find(s => s.id === args.id);
        if (!skill) throw new Error('skill was not granted to this member');
        return { ...skill, source: 'dispatch snapshot' };
      }
      return loadSkill(catalog, args.id, skillOptions(actor, rt.config));
    },
  });
}
