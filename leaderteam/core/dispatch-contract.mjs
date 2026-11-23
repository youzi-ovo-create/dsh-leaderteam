// Cheap deterministic admission before a paid gate call, and again at actual dispatch.
import { hydrateStageDispatch, requireReadyStage, stageApproval } from './frontier.mjs';
import { MEMBER_NAME_RE } from './constants.mjs';
import { memberToolGrant } from './tool-policy.mjs';
import { assertRecoveryStrategy } from './execution-recovery.mjs';
import { validateExecutionChoice } from './models.mjs';
import { isAutonomousGovernance } from './governance-protocol.mjs';

export function dispatchContract(store, cfg, taskSeq, original) {
  const autonomous = isAutonomousGovernance(cfg);
  const requirePlanId = !autonomous && Boolean(original.stage_id);
  const missing = ['model', 'effort', ...(requirePlanId ? ['plan_id'] : [])].filter(k => typeof original[k] !== 'string' || !original[k].trim());
  if (missing.length) {
    let approvalHint = '';
    if (original.stage_id && missing.includes('plan_id')) {
      try {
        const stage = requireReadyStage(store, taskSeq, original.stage_id), id = stageApproval(store, taskSeq, stage);
        if (id) approvalHint = ` This exact stage/version is already approved: pass plan_id="${id}".`;
      } catch { /* malformed/missing stage is checked normally after all required arguments are supplied */ }
    }
    const callHint = autonomous
      ? 'Call team_dispatch with explicit {name,stage_id,model,effort} (or inline task/profile/tools/write_scope/acceptance); select model and supported effort using team_models.'
      : 'Call team_dispatch with explicit {name,stage_id,plan_id,model,effort}; select model and supported effort using team_models.';
    throw new Error(`Missing required dispatch arguments: ${missing.join(', ')}.${approvalHint} This is an argument error, not a request to revise or re-review an unchanged approved stage. ${callHint} No task was dispatched.`);
  }
  let args = original;
  if (!autonomous && cfg.team.rollingPlanning && original.profile !== 'readonly' && !original.stage_id) {
    throw new Error('rolling planning requires stage_id and its approved plan_id for writing members; record a stage with team_plan, submit its execution review, and continue later planning while it runs');
  }
  if (original.stage_id) args = hydrateStageDispatch(store, taskSeq, original, { requireApproval: !autonomous });
  if (typeof args.name !== 'string' || !MEMBER_NAME_RE.test(args.name)) throw new Error('invalid member name');
  if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('missing required property "task" (or an approved stage_id)');
  if (!Array.isArray(args.acceptance) || !args.acceptance.length) throw new Error('missing required property "acceptance"');
  if (!cfg.derived.memberProfiles.includes(args.profile)) throw new Error('missing or invalid member profile');
  if (!Array.isArray(args.tools) || !args.tools.length) throw new Error('missing required property "tools"');
  memberToolGrant(cfg, args.profile, args.tools, args.defer_tools ?? []);
  if (cfg.profiles[args.profile].mutating && (!Array.isArray(args.write_scope) || !args.write_scope.length)) throw new Error(`profile "${args.profile}" writes files: write_scope must list at least one workspace-relative glob`);
  const prefix = `${cfg.magpie.provider}/`;
  const unprefixed = args.model.startsWith(prefix) ? args.model.slice(prefix.length) : args.model;
  const model = cfg.team.executionPool.includes(unprefixed) ? unprefixed : args.model;
  const choice = validateExecutionChoice(cfg, model, args.effort);
  if (!choice.ok) throw new Error(choice.error);
  assertRecoveryStrategy(store, { taskSeq, stageId: args.stage_id, stageHash: args.stageHash,
    model, effort: args.effort });
  return model === args.model ? args : { ...args, model };
}
