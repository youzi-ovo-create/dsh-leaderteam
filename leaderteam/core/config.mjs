// Product config loading and validation. Pure except loadConfig (reads one file).
import fs from 'node:fs';
import path from 'node:path';
import { LtError, FAMILIES, PROFILE_ID_RE, RULE_ONLY_ELIGIBLE_TOOLS, MODEL_ROUTE_RE, EFFORT_ID_RE, DSH_EFFORTS } from './constants.mjs';
import { normalizeGlob } from './paths.mjs';
import { deepFreeze } from './canonical.mjs';

import { DEFAULT_SCHEDULER_CONFIG } from './scheduler.mjs';
import { DEFAULT_TIMER_CONFIG } from './timer.mjs';
import { DEFAULT_PLAN_ARCHIVE_CONFIG } from './plan-archive.mjs';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from './circuit-breaker.mjs';
import { DEFAULT_GOVERNANCE_CONFIG } from './governance-protocol.mjs';

const ROLE_KEYS = ['leader', 'gate', 'discussA', 'discussB', 'arbiter', 'serialReviewer', 'directExec'];
const FORBIDDEN_UNCONTROLLED = ['team_dispatch', 'team_note', 'team_plan', 'write', 'edit', 'bash', 'pwsh'];

function parseJsonFile(file, label = 'config') {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new LtError('BAD_CONFIG', `cannot read ${label} ${file}: ${e.message}`); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch (e) { throw new LtError('BAD_CONFIG', `${label} ${file} is not valid JSON: ${e.message}`); }
}

export function deepMergePlain(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return structuredClone(over);
  const out = (base !== null && typeof base === 'object' && !Array.isArray(base)) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) out[k] = deepMergePlain(out[k], v);
  }
  return out;
}

export function loadConfig(file, options = {}) {
  return validateConfig(loadRawConfig(file, options));
}

export function loadRawConfig(file, options = {}) {
  let raw = parseJsonFile(file, 'config');
  if (options.includeLocal !== false && path.basename(file) === 'leaderteam.config.json') {
    const localFile = options.localFile ?? path.join(path.dirname(file), 'leaderteam.local.json');
    if (fs.existsSync(localFile)) {
      const localRaw = parseJsonFile(localFile, 'local config override');
      if (localRaw === null || typeof localRaw !== 'object' || Array.isArray(localRaw)) {
        throw new LtError('BAD_CONFIG', `local config override ${localFile} must be a JSON object`);
      }
      raw = deepMergePlain(raw, localRaw);
    }
  }
  return raw;
}

/** Validate and normalize; throws LtError('BAD_CONFIG') listing every problem. Returns a deep-frozen config. */
export function validateConfig(raw) {
  const p = [];
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const onlyKeys = (obj, allowed, at) => {
    if (!isObj(obj)) return;
    const set = new Set(allowed);
    for (const k of Object.keys(obj)) if (!set.has(k)) p.push(`unknown config property "${at ? `${at}.${k}` : k}"`);
  };
  const str = (v, path) => { if (typeof v !== 'string' || v.trim() === '') { p.push(`${path} must be a non-empty string`); return false; } return true; };
  const strArr = (v, path, { nonEmpty = false } = {}) => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.trim() === '')) { p.push(`${path} must be an array of non-empty strings`); return false; }
    if (nonEmpty && v.length === 0) { p.push(`${path} must not be empty`); return false; }
    if (new Set(v).size !== v.length) { p.push(`${path} contains duplicates`); return false; }
    return true;
  };
  const int = (v, path, min, max) => { if (!Number.isInteger(v) || v < min || v > max) { p.push(`${path} must be an integer in [${min}, ${max}]`); return false; } return true; };
  const num = (v, path, min, max) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) { p.push(`${path} must be a number in [${min}, ${max}]`); return false; } return true; };
  const bool = (v, path) => { if (typeof v !== 'boolean') { p.push(`${path} must be a boolean`); return false; } return true; };

  if (!isObj(raw)) throw new LtError('BAD_CONFIG', 'config must be a JSON object');
  onlyKeys(raw, ['schemaVersion', 'magpie', 'models', 'roles', 'toolPolicy', 'skills', 'profiles', 'gate', 'quota', 'paths', 'team', 'agreement', 'storage', 'scheduler', 'timer', 'planArchive', 'plugins', 'circuitBreaker', 'governance'], '');
  if (raw.schemaVersion !== 1) p.push('schemaVersion must be 1');
  if (!isObj(raw.magpie)) p.push('magpie must be an object');
  else { onlyKeys(raw.magpie, ['provider'], 'magpie'); str(raw.magpie.provider, 'magpie.provider'); }

  const models = isObj(raw.models) ? raw.models : (p.push('models must be an object'), {});
  for (const [route, m] of Object.entries(models)) {
    const at = `models["${route}"]`;
    if (!MODEL_ROUTE_RE.test(route)) p.push(`${at}: route must look like "<provider>/<model>"`);
    if (!isObj(m)) { p.push(`${at} must be an object`); continue; }
    onlyKeys(m, ['family', 'label', 'efforts', 'defaultEffort', 'strengths', 'quotaWindows', 'vision', 'provider', 'upstreamModel', 'contextWindow', 'maxTokens'], at);
    if (!FAMILIES.includes(m.family)) p.push(`${at}.family must be one of ${FAMILIES.join(', ')}`);
    str(m.label, `${at}.label`);
    if (strArr(m.efforts, `${at}.efforts`, { nonEmpty: true })) {
      for (const eff of m.efforts) {
        if (!EFFORT_ID_RE.test(eff)) p.push(`${at}.efforts entry "${eff}" must match ${EFFORT_ID_RE}`);
        else if (!DSH_EFFORTS.includes(eff)) p.push(`${at}.efforts entry "${eff}" is unsupported by DSH; use one of ${DSH_EFFORTS.join(', ')}`);
      }
      if (!m.efforts.includes(m.defaultEffort)) p.push(`${at}.defaultEffort must be one of its efforts`);
    }
    if (m.strengths !== undefined) str(m.strengths, `${at}.strengths`);
    if (m.quotaWindows !== undefined) strArr(m.quotaWindows, `${at}.quotaWindows`, { nonEmpty: true });
    if (m.vision !== undefined) bool(m.vision, `${at}.vision`);
    if (m.provider !== undefined) str(m.provider, `${at}.provider`);
    if (m.upstreamModel !== undefined) str(m.upstreamModel, `${at}.upstreamModel`);
    if (m.contextWindow !== undefined) int(m.contextWindow, `${at}.contextWindow`, 1, Number.MAX_SAFE_INTEGER);
    if (m.maxTokens !== undefined) int(m.maxTokens, `${at}.maxTokens`, 1, Number.MAX_SAFE_INTEGER);
  }
  const effortOk = (route, effort, at) => {
    const m = models[route];
    if (!m) { p.push(`${at}.route "${route}" is not in models`); return; }
    if (!Array.isArray(m.efforts) || !m.efforts.includes(effort)) p.push(`${at}.effort "${effort}" is not supported by ${route}`);
  };
  if (!isObj(raw.roles)) p.push('roles must be an object');
  else {
    onlyKeys(raw.roles, ROLE_KEYS, 'roles');
    for (const k of ROLE_KEYS) {
      if ((k === 'serialReviewer' || k === 'directExec') && raw.roles[k] === undefined) continue;
      const r = raw.roles[k]; const at = `roles.${k}`;
      if (!isObj(r)) { p.push(`${at} must be an object`); continue; }
      onlyKeys(r, k === 'leader' ? ['route', 'effort', 'maxTokens'] : ['route', 'effort', 'maxTokens', 'timeoutMs', 'retries', 'fallback'], at);
      if (str(r.route, `${at}.route`) && str(r.effort, `${at}.effort`)) effortOk(r.route, r.effort, at);
      if (r.maxTokens !== undefined) int(r.maxTokens, `${at}.maxTokens`, 64, Number.MAX_SAFE_INTEGER);
      if (k !== 'leader') {
        int(r.timeoutMs, `${at}.timeoutMs`, 1000, 3600000);
        int(r.retries, `${at}.retries`, 0, 5);
        // Ordered fallback routes, tried only when every earlier route is unavailable (core/role-routes.mjs).
        if (r.fallback !== undefined) {
          if (!Array.isArray(r.fallback) || r.fallback.length > 4) p.push(`${at}.fallback must be an array of at most 4 routes`);
          else r.fallback.forEach((f, i) => {
            const fat = `${at}.fallback[${i}]`;
            if (!isObj(f)) { p.push(`${fat} must be an object`); return; }
            onlyKeys(f, ['route', 'effort', 'maxTokens', 'timeoutMs', 'retries'], fat);
            if (str(f.route, `${fat}.route`) && str(f.effort, `${fat}.effort`)) effortOk(f.route, f.effort, fat);
            if (f.maxTokens !== undefined) int(f.maxTokens, `${fat}.maxTokens`, 64, Number.MAX_SAFE_INTEGER);
            if (f.timeoutMs !== undefined) int(f.timeoutMs, `${fat}.timeoutMs`, 1000, 3600000);
            if (f.retries !== undefined) int(f.retries, `${fat}.retries`, 0, 5);
            if (f.route === r.route) p.push(`${fat}.route repeats the primary route`);
          });
        }
      }
    }
  }
  // Roles are independently configurable; even the same model can review in separate requests.
  if (raw.toolPolicy !== undefined) {
    if (!isObj(raw.toolPolicy)) p.push('toolPolicy must be an object');
    else { onlyKeys(raw.toolPolicy, ['additionalTools'], 'toolPolicy'); strArr(raw.toolPolicy.additionalTools, 'toolPolicy.additionalTools'); }
  }
  if (raw.skills !== undefined) {
    if (!isObj(raw.skills)) p.push('skills must be an object');
    else { onlyKeys(raw.skills, ['roots'], 'skills'); strArr(raw.skills.roots, 'skills.roots'); }
  }

  const profiles = isObj(raw.profiles) ? raw.profiles : (p.push('profiles must be an object'), {});
  if (!isObj(profiles.leader)) p.push('profiles.leader must be an object');
  else {
    onlyKeys(profiles.leader, ['preset', 'tools', 'description'], 'profiles.leader');
    str(profiles.leader.preset, 'profiles.leader.preset');
    strArr(profiles.leader.tools, 'profiles.leader.tools', { nonEmpty: true });
    if (profiles.leader.description !== undefined) str(profiles.leader.description, 'profiles.leader.description');
  }
  const memberProfiles = Object.keys(profiles).filter(k => k !== 'leader');
  if (memberProfiles.length === 0) p.push('profiles must define at least one member profile');
  for (const id of memberProfiles) {
    const pr = profiles[id]; const at = `profiles.${id}`;
    if (!PROFILE_ID_RE.test(id)) p.push(`${at}: profile id must match ${PROFILE_ID_RE}`);
    if (!isObj(pr)) { p.push(`${at} must be an object`); continue; }
    onlyKeys(pr, ['preset', 'tools', 'mutating', 'description'], at);
    str(pr.preset, `${at}.preset`); strArr(pr.tools, `${at}.tools`, { nonEmpty: true }); bool(pr.mutating, `${at}.mutating`); str(pr.description, `${at}.description`);
  }

  const g = isObj(raw.gate) ? raw.gate : (p.push('gate must be an object'), {});
  onlyKeys(g, ['scope', 'sandboxDirectAllow', 'enablePatternCache', 'uncontrolledTools', 'shellTools', 'mutatingTools', 'pathArgs', 'requireReadBeforeWrite', 'maxArgChars', 'maxAuthorizationChars', 'dedupeDeniedCalls', 'maxReviewsPerMember', 'maxDenialsPerMember', 'maxReviewsPerTask', 'ruleOnlyTools', 'maxConsecutiveGateErrors', 'gateErrorCooldownMs'], 'gate');
  if (g.sandboxDirectAllow !== undefined) bool(g.sandboxDirectAllow, 'gate.sandboxDirectAllow');
  if (g.enablePatternCache !== undefined) bool(g.enablePatternCache, 'gate.enablePatternCache');
  // "all" was never a working mode: it left ordinary sessions without any tool. Only team sessions are governed.
  if (g.scope !== 'team') p.push(g.scope === 'all' ? 'gate.scope "all" is not supported (it would remove every tool from ordinary sessions); use "team"' : 'gate.scope must be "team"');
  strArr(g.uncontrolledTools, 'gate.uncontrolledTools'); strArr(g.shellTools, 'gate.shellTools'); strArr(g.mutatingTools, 'gate.mutatingTools');
  if (!isObj(g.pathArgs)) p.push('gate.pathArgs must be an object'); else for (const [t, a] of Object.entries(g.pathArgs)) strArr(a, `gate.pathArgs.${t}`, { nonEmpty: true });
  bool(g.requireReadBeforeWrite, 'gate.requireReadBeforeWrite');
  int(g.maxArgChars, 'gate.maxArgChars', 1000, 200000); int(g.maxAuthorizationChars, 'gate.maxAuthorizationChars', 200, 50000);
  if (g.dedupeDeniedCalls !== undefined) bool(g.dedupeDeniedCalls, 'gate.dedupeDeniedCalls');
  if (g.maxReviewsPerMember !== undefined && g.maxReviewsPerMember !== null) int(g.maxReviewsPerMember, 'gate.maxReviewsPerMember', 1, 100000);
  if (g.maxDenialsPerMember !== undefined && g.maxDenialsPerMember !== null) int(g.maxDenialsPerMember, 'gate.maxDenialsPerMember', 1, 500);
  if (g.maxReviewsPerTask !== undefined && g.maxReviewsPerTask !== null) int(g.maxReviewsPerTask, 'gate.maxReviewsPerTask', 1, 200000);
  if (g.ruleOnlyTools !== undefined) {
    strArr(g.ruleOnlyTools, 'gate.ruleOnlyTools');
    if (Array.isArray(g.ruleOnlyTools)) for (const t of g.ruleOnlyTools) if (!RULE_ONLY_ELIGIBLE_TOOLS.includes(t)) p.push(`gate.ruleOnlyTools: "${t}" must stay model-reviewed (only ${RULE_ONLY_ELIGIBLE_TOOLS.join(', ')} may be rule-only)`);
  }
  if (g.maxConsecutiveGateErrors !== undefined && g.maxConsecutiveGateErrors !== null) int(g.maxConsecutiveGateErrors, 'gate.maxConsecutiveGateErrors', 1, 100);
  if (g.gateErrorCooldownMs !== undefined) int(g.gateErrorCooldownMs, 'gate.gateErrorCooldownMs', 1000, 3600000);
  if (Array.isArray(g.uncontrolledTools)) {
    const neverUncontrolled = new Set([...(Array.isArray(g.mutatingTools) ? g.mutatingTools : []), ...(Array.isArray(g.shellTools) ? g.shellTools : []), ...FORBIDDEN_UNCONTROLLED]);
    for (const t of neverUncontrolled) if (g.uncontrolledTools.includes(t)) p.push(`gate: mutating tool "${t}" cannot be uncontrolled`);
  }

  const q = isObj(raw.quota) ? raw.quota : (p.push('quota must be an object'), {});
  onlyKeys(q, ['stateFile', 'maxSnapshotAgeSec', 'exhaustedBelowPct', 'lowBelowPct', 'allowUnknown', 'allowUnknownGpt', 'gptReservePct'], 'quota');
  if (q.stateFile !== null && (typeof q.stateFile !== 'string' || q.stateFile.trim() === '')) p.push('quota.stateFile must be a non-empty string or null');
  int(q.maxSnapshotAgeSec, 'quota.maxSnapshotAgeSec', 30, 86400);
  num(q.exhaustedBelowPct, 'quota.exhaustedBelowPct', 0, 100); num(q.lowBelowPct, 'quota.lowBelowPct', 0, 100); bool(q.allowUnknown, 'quota.allowUnknown');
  if (q.allowUnknownGpt !== undefined) bool(q.allowUnknownGpt, 'quota.allowUnknownGpt');
  if (q.gptReservePct !== undefined) num(q.gptReservePct, 'quota.gptReservePct', 0, 50);
  if (typeof q.exhaustedBelowPct === 'number' && typeof q.lowBelowPct === 'number' && q.exhaustedBelowPct > q.lowBelowPct) p.push('quota.exhaustedBelowPct must be <= quota.lowBelowPct');

  const pa = isObj(raw.paths) ? raw.paths : (p.push('paths must be an object'), {});
  onlyKeys(pa, ['globalRefRoots', 'projectRefsDir', 'protectedDirs', 'leaderReadRoots'], 'paths');
  strArr(pa.globalRefRoots, 'paths.globalRefRoots');
  if (str(pa.projectRefsDir, 'paths.projectRefsDir')) { try { normalizeGlob(pa.projectRefsDir); } catch { p.push('paths.projectRefsDir must be a workspace-relative path'); } }
  strArr(pa.protectedDirs, 'paths.protectedDirs', { nonEmpty: true });
  if (pa.leaderReadRoots !== undefined) strArr(pa.leaderReadRoots, 'paths.leaderReadRoots'); // optional: extra read-only roots for the leader

  const t = isObj(raw.team) ? raw.team : (p.push('team must be an object'), {});
  onlyKeys(t, ['executionPool', 'maxMembersPerTeam', 'maxActiveMembers', 'requirePlanAgreement', 'planExemptProfiles', 'maxPlanAgreements', 'maxDiscussionsPerTask', 'maxRefsPerMember', 'leaderModelPolicy', 'leaderModelAsLastResort', 'autoIncludeUpstreamModels', 'disabledModels', 'disabledFamilies', 'rollingPlanning'], 'team');
  if (t.rollingPlanning !== undefined) bool(t.rollingPlanning, 'team.rollingPlanning');
  if (strArr(t.executionPool, 'team.executionPool', { nonEmpty: true })) for (const r of t.executionPool) if (!models[r]) p.push(`team.executionPool: "${r}" is not in models`);
  int(t.maxMembersPerTeam, 'team.maxMembersPerTeam', 1, 10000); bool(t.requirePlanAgreement, 'team.requirePlanAgreement');
  if (t.maxActiveMembers !== undefined) int(t.maxActiveMembers, 'team.maxActiveMembers', 1, 200);
  if (t.leaderModelAsLastResort !== undefined) bool(t.leaderModelAsLastResort, 'team.leaderModelAsLastResort');
  if (strArr(t.planExemptProfiles, 'team.planExemptProfiles')) for (const x of t.planExemptProfiles) if (!memberProfiles.includes(x)) p.push(`team.planExemptProfiles: unknown profile "${x}"`);
  int(t.maxPlanAgreements, 'team.maxPlanAgreements', 1, 50); int(t.maxRefsPerMember, 'team.maxRefsPerMember', 0, 100);
  if (t.maxDiscussionsPerTask !== undefined && t.maxDiscussionsPerTask !== null) int(t.maxDiscussionsPerTask, 'team.maxDiscussionsPerTask', 1, 10000);
  if (t.leaderModelPolicy !== undefined && !['enforce', 'warn', 'off'].includes(t.leaderModelPolicy)) p.push('team.leaderModelPolicy must be "enforce", "warn" or "off"');
  if (t.autoIncludeUpstreamModels !== undefined) bool(t.autoIncludeUpstreamModels, 'team.autoIncludeUpstreamModels');
  if (t.disabledModels !== undefined) strArr(t.disabledModels, 'team.disabledModels');
  if (t.disabledFamilies !== undefined && strArr(t.disabledFamilies, 'team.disabledFamilies')) {
    for (const f of t.disabledFamilies) if (!FAMILIES.includes(f)) p.push(`team.disabledFamilies: unknown family "${f}"`);
  }

  const a = isObj(raw.agreement) ? raw.agreement : (p.push('agreement must be an object'), {});
  onlyKeys(a, ['maxRounds', 'maxProposalChars', 'maxEvidenceChars', 'maxEvidenceFiles', 'evidenceFileMaxBytes', 'maxArbiterAttempts'], 'agreement');
  int(a.maxRounds, 'agreement.maxRounds', 1, 5); int(a.maxProposalChars, 'agreement.maxProposalChars', 500, 500000);
  int(a.maxEvidenceChars, 'agreement.maxEvidenceChars', 0, 2000000); int(a.maxEvidenceFiles, 'agreement.maxEvidenceFiles', 0, 200);
  int(a.evidenceFileMaxBytes, 'agreement.evidenceFileMaxBytes', 1000, 5000000); int(a.maxArbiterAttempts, 'agreement.maxArbiterAttempts', 1, 5);

  if (raw.storage !== undefined) {
    if (!isObj(raw.storage)) p.push('storage.root must be a string or null');
    else {
      onlyKeys(raw.storage, ['root'], 'storage');
      if (raw.storage.root !== null && typeof raw.storage.root !== 'string') p.push('storage.root must be a string or null');
    }
  }

  if (raw.timer !== undefined) {
    if (!isObj(raw.timer)) p.push('timer must be an object');
    else {
      const tm = raw.timer;
      onlyKeys(tm, ['enabled', 'elevatedAfterMs', 'stagnationAfterMs', 'idleGapCapMs'], 'timer');
      if (tm.enabled !== undefined) bool(tm.enabled, 'timer.enabled');
      const elOk = tm.elevatedAfterMs === undefined || int(tm.elevatedAfterMs, 'timer.elevatedAfterMs', 10, 86400000);
      const stOk = tm.stagnationAfterMs === undefined || int(tm.stagnationAfterMs, 'timer.stagnationAfterMs', 10, 86400000);
      if (tm.idleGapCapMs !== undefined) int(tm.idleGapCapMs, 'timer.idleGapCapMs', 10, 3600000);
      const effTm = { ...DEFAULT_TIMER_CONFIG, ...tm };
      if (elOk && stOk && effTm.elevatedAfterMs > effTm.stagnationAfterMs) {
        p.push('timer.elevatedAfterMs must be <= timer.stagnationAfterMs');
      }
    }
  }

  if (raw.planArchive !== undefined) {
    if (!isObj(raw.planArchive)) p.push('planArchive must be an object');
    else {
      const paCfg = raw.planArchive;
      onlyKeys(paCfg, ['enabled', 'root', 'minUnapprovedPlansForFallback', 'allowAutoFallbackOnDispatch', 'useArbiterForBestPlan'], 'planArchive');
      if (paCfg.enabled !== undefined) bool(paCfg.enabled, 'planArchive.enabled');
      if (paCfg.root !== undefined && paCfg.root !== null) {
        if (typeof paCfg.root !== 'string' || paCfg.root.trim() === '') {
          p.push('planArchive.root must be a non-empty absolute path string or null');
        } else if (!path.win32.isAbsolute(paCfg.root.trim()) && !path.posix.isAbsolute(paCfg.root.trim())) {
          p.push('planArchive.root must be an absolute external path (never relative to a project workspace)');
        }
      }
      if (paCfg.minUnapprovedPlansForFallback !== undefined) int(paCfg.minUnapprovedPlansForFallback, 'planArchive.minUnapprovedPlansForFallback', 1, 50);
      if (paCfg.allowAutoFallbackOnDispatch !== undefined) bool(paCfg.allowAutoFallbackOnDispatch, 'planArchive.allowAutoFallbackOnDispatch');
      if (paCfg.useArbiterForBestPlan !== undefined) bool(paCfg.useArbiterForBestPlan, 'planArchive.useArbiterForBestPlan');
    }
  }

  if (raw.plugins !== undefined) {
    if (!isObj(raw.plugins)) p.push('plugins must be an object');
    else {
      onlyKeys(raw.plugins, ['scheduler', 'consensus', 'timerArchive', 'panel'], 'plugins');
      for (const pk of ['scheduler', 'consensus', 'timerArchive', 'panel']) {
        if (raw.plugins[pk] !== undefined) bool(raw.plugins[pk], `plugins.${pk}`);
      }
    }
  }

  if (raw.scheduler !== undefined) {
    if (!isObj(raw.scheduler)) p.push('scheduler must be an object');
    else {
      const s = raw.scheduler;
      onlyKeys(s, [
        'enabled', 'sampleIntervalMs', 'pollControlMs', 'rampStepSize', 'rampObserveMs',
        'hysteresisCooldownMs', 'hysteresisRecoverSamples', 'highCpuPct', 'recoverCpuPct',
        'lowFreePhysMib', 'recoverFreePhysMib', 'criticalFreePhysMib',
        'lowFreeCommitMib', 'recoverFreeCommitMib', 'highCommitUsedPct', 'recoverCommitUsedPct',
        'memberMemoryMib', 'maxConcurrentShellMembers', 'gateQueueHighWater', 'gateQueueRecoverWater',
        'rateLimitWindowMs', 'maxAutoWakeupsPerTask',
      ], 'scheduler');
      if (s.enabled !== undefined) bool(s.enabled, 'scheduler.enabled');
      if (s.sampleIntervalMs !== undefined) int(s.sampleIntervalMs, 'scheduler.sampleIntervalMs', 250, 60000);
      if (s.pollControlMs !== undefined) int(s.pollControlMs, 'scheduler.pollControlMs', 100, 30000);
      if (s.rampStepSize !== undefined) int(s.rampStepSize, 'scheduler.rampStepSize', 1, 200);
      if (s.rampObserveMs !== undefined) int(s.rampObserveMs, 'scheduler.rampObserveMs', 100, 60000);
      if (s.hysteresisCooldownMs !== undefined) int(s.hysteresisCooldownMs, 'scheduler.hysteresisCooldownMs', 0, 300000);
      if (s.hysteresisRecoverSamples !== undefined) int(s.hysteresisRecoverSamples, 'scheduler.hysteresisRecoverSamples', 1, 20);
      const highCpuOk = s.highCpuPct === undefined || num(s.highCpuPct, 'scheduler.highCpuPct', 20, 100);
      const recCpuOk = s.recoverCpuPct === undefined || num(s.recoverCpuPct, 'scheduler.recoverCpuPct', 5, 99);
      const cpuOk = highCpuOk && recCpuOk;
      const lowPhysOk = s.lowFreePhysMib === undefined || int(s.lowFreePhysMib, 'scheduler.lowFreePhysMib', 32, 65536);
      const recPhysOk = s.recoverFreePhysMib === undefined || int(s.recoverFreePhysMib, 'scheduler.recoverFreePhysMib', 32, 65536);
      const critPhysOk = s.criticalFreePhysMib === undefined || int(s.criticalFreePhysMib, 'scheduler.criticalFreePhysMib', 16, 65536);
      const physOk = lowPhysOk && recPhysOk && critPhysOk;
      const lowComOk = s.lowFreeCommitMib === undefined || int(s.lowFreeCommitMib, 'scheduler.lowFreeCommitMib', 64, 262144);
      const recComOk = s.recoverFreeCommitMib === undefined || int(s.recoverFreeCommitMib, 'scheduler.recoverFreeCommitMib', 64, 262144);
      const commitMibOk = lowComOk && recComOk;
      const highComPctOk = s.highCommitUsedPct === undefined || num(s.highCommitUsedPct, 'scheduler.highCommitUsedPct', 50, 100);
      const recComPctOk = s.recoverCommitUsedPct === undefined || num(s.recoverCommitUsedPct, 'scheduler.recoverCommitUsedPct', 20, 99);
      const commitPctOk = highComPctOk && recComPctOk;
      if (s.memberMemoryMib !== undefined) {
        if (!isObj(s.memberMemoryMib)) p.push('scheduler.memberMemoryMib must be an object');
        else {
          for (const [k, v] of Object.entries(s.memberMemoryMib)) {
            if (!memberProfiles.includes(k)) p.push(`scheduler.memberMemoryMib: unknown profile "${k}"`);
            int(v, `scheduler.memberMemoryMib.${k}`, 16, 16384);
          }
        }
      }
      if (s.maxConcurrentShellMembers !== undefined) int(s.maxConcurrentShellMembers, 'scheduler.maxConcurrentShellMembers', 1, 200);
      const gateHighOk = s.gateQueueHighWater === undefined || int(s.gateQueueHighWater, 'scheduler.gateQueueHighWater', 1, 100);
      const gateRecOk = s.gateQueueRecoverWater === undefined || int(s.gateQueueRecoverWater, 'scheduler.gateQueueRecoverWater', 0, 100);
      const gateWaterOk = gateHighOk && gateRecOk;
      if (s.rateLimitWindowMs !== undefined) int(s.rateLimitWindowMs, 'scheduler.rateLimitWindowMs', 1000, 600000);
      if (s.maxAutoWakeupsPerTask !== undefined) int(s.maxAutoWakeupsPerTask, 'scheduler.maxAutoWakeupsPerTask', 0, 200);

      // Validate hysteresis watermarks against merged defaults so partial .local.json overrides cannot invert thresholds
      const eff = { ...DEFAULT_SCHEDULER_CONFIG, ...s };
      if (cpuOk && eff.recoverCpuPct >= eff.highCpuPct) {
        p.push('scheduler.recoverCpuPct must be < scheduler.highCpuPct');
      }
      if (physOk && eff.criticalFreePhysMib > eff.lowFreePhysMib) {
        p.push('scheduler.criticalFreePhysMib must be <= scheduler.lowFreePhysMib');
      }
      if (physOk && eff.recoverFreePhysMib < eff.lowFreePhysMib) {
        p.push('scheduler.recoverFreePhysMib must be >= scheduler.lowFreePhysMib');
      }
      if (commitMibOk && eff.recoverFreeCommitMib < eff.lowFreeCommitMib) {
        p.push('scheduler.recoverFreeCommitMib must be >= scheduler.lowFreeCommitMib');
      }
      if (commitPctOk && eff.recoverCommitUsedPct >= eff.highCommitUsedPct) {
        p.push('scheduler.recoverCommitUsedPct must be < scheduler.highCommitUsedPct');
      }
      if (gateWaterOk && eff.gateQueueRecoverWater >= eff.gateQueueHighWater) {
        p.push('scheduler.gateQueueRecoverWater must be < scheduler.gateQueueHighWater');
      }
    }
  }

  if (raw.circuitBreaker !== undefined) {
    if (!isObj(raw.circuitBreaker)) p.push('circuitBreaker must be an object');
    else {
      const cb = raw.circuitBreaker;
      onlyKeys(cb, [
        'enabled', 'investigatorRole',
        'zeroProgressTruncationSoft', 'zeroProgressTruncationHard',
        'repeatedFailureSoft', 'repeatedFailureHard',
        'identicalSignatureSoft', 'identicalSignatureHard',
        'stagnantSpinSoft', 'stagnantSpinHard',
        'runtimeErrorSoft', 'runtimeErrorHard',
        'cooldownMs', 'maxConsolidationsPerAgent',
      ], 'circuitBreaker');
      if (cb.enabled !== undefined) bool(cb.enabled, 'circuitBreaker.enabled');
      if (cb.investigatorRole !== undefined && !['arbiter', 'discussA', 'discussB', 'gate'].includes(cb.investigatorRole)) {
        p.push('circuitBreaker.investigatorRole must be one of arbiter, discussA, discussB, gate');
      }
      for (const k of [
        'zeroProgressTruncationSoft', 'zeroProgressTruncationHard',
        'repeatedFailureSoft', 'repeatedFailureHard',
        'identicalSignatureSoft', 'identicalSignatureHard',
        'stagnantSpinSoft', 'stagnantSpinHard',
        'runtimeErrorSoft', 'runtimeErrorHard',
        'maxConsolidationsPerAgent',
      ]) {
        if (cb[k] !== undefined) int(cb[k], `circuitBreaker.${k}`, 1, 10000);
      }
      if (cb.cooldownMs !== undefined) int(cb.cooldownMs, 'circuitBreaker.cooldownMs', 0, 3600000);
    }
  }

  if (raw.governance !== undefined) {
    if (!isObj(raw.governance)) p.push('governance must be an object');
    else {
      const gv = raw.governance;
      onlyKeys(gv, [
        'mode', 'caucusQuorumNumerator', 'caucusQuorumDenominator',
        'maxInternalArbitrationRounds', 'maxConferenceDialogueTurns',
        'autoSuperviseStages', 'autoSuperviseDispatches', 'directExecMaxSteps',
        'pauseBarrierTimeoutMs',
      ], 'governance');
      if (gv.mode !== undefined && !['autonomous', 'approval'].includes(gv.mode)) {
        p.push('governance.mode must be "autonomous" or "approval"');
      }
      if (gv.caucusQuorumNumerator !== undefined) int(gv.caucusQuorumNumerator, 'governance.caucusQuorumNumerator', 1, 10);
      if (gv.caucusQuorumDenominator !== undefined) int(gv.caucusQuorumDenominator, 'governance.caucusQuorumDenominator', 1, 10);
      if (gv.maxInternalArbitrationRounds !== undefined) int(gv.maxInternalArbitrationRounds, 'governance.maxInternalArbitrationRounds', 1, 5);
      if (gv.maxConferenceDialogueTurns !== undefined) int(gv.maxConferenceDialogueTurns, 'governance.maxConferenceDialogueTurns', 0, 5);
      if (gv.autoSuperviseStages !== undefined) bool(gv.autoSuperviseStages, 'governance.autoSuperviseStages');
      if (gv.autoSuperviseDispatches !== undefined) bool(gv.autoSuperviseDispatches, 'governance.autoSuperviseDispatches');
      if (gv.directExecMaxSteps !== undefined) int(gv.directExecMaxSteps, 'governance.directExecMaxSteps', 1, 200);
      if (gv.pauseBarrierTimeoutMs !== undefined) int(gv.pauseBarrierTimeoutMs, 'governance.pauseBarrierTimeoutMs', 50, 300000);
    }
  }

  if (p.length) throw new LtError('BAD_CONFIG', `invalid leaderteam config:\n- ${p.join('\n- ')}`, { problems: p });
  const cfg = structuredClone(raw);
  cfg.roles.serialReviewer ??= {
    ...structuredClone(cfg.roles.discussA),
    ...(cfg.roles.discussA.maxTokens !== undefined ? { maxTokens: cfg.roles.discussA.maxTokens } : {}),
    timeoutMs: Math.min(cfg.roles.discussA.timeoutMs, 180000),
    retries: 0,
  };
  const defaultExecRoute = cfg.team.executionPool[0] ?? cfg.roles.leader.route;
  cfg.roles.directExec ??= {
    route: defaultExecRoute,
    effort: cfg.models[defaultExecRoute]?.defaultEffort ?? cfg.roles.leader.effort,
    timeoutMs: 180000,
    retries: 1,
    fallback: [],
  };
  cfg.storage = { root: raw.storage?.root ?? null };
  cfg.timer = { ...DEFAULT_TIMER_CONFIG, ...(raw.timer ?? {}) };
  cfg.planArchive = { ...DEFAULT_PLAN_ARCHIVE_CONFIG, ...(raw.planArchive ?? {}) };
  cfg.circuitBreaker = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...(raw.circuitBreaker ?? {}) };
  cfg.governance = { ...DEFAULT_GOVERNANCE_CONFIG, ...(raw.governance ?? {}) };
  cfg.plugins = {
    scheduler: raw.plugins?.scheduler ?? true,
    consensus: raw.plugins?.consensus ?? true,
    timerArchive: raw.plugins?.timerArchive ?? true,
    panel: raw.plugins?.panel ?? true,
  };
  cfg.scheduler = {
    ...DEFAULT_SCHEDULER_CONFIG,
    ...(raw.scheduler ?? {}),
    memberMemoryMib: {
      ...DEFAULT_SCHEDULER_CONFIG.memberMemoryMib,
      ...(raw.scheduler?.memberMemoryMib ?? {}),
    },
  };
  if (cfg.team.leaderModelPolicy === undefined) cfg.team.leaderModelPolicy = 'enforce';
  if (cfg.team.maxActiveMembers === undefined) cfg.team.maxActiveMembers = Math.min(cfg.team.maxMembersPerTeam, 8);
  if (cfg.team.maxDiscussionsPerTask === undefined) cfg.team.maxDiscussionsPerTask = null;
  if (cfg.team.autoIncludeUpstreamModels === undefined) cfg.team.autoIncludeUpstreamModels = false;
  if (cfg.team.disabledModels === undefined) cfg.team.disabledModels = [];
  if (cfg.team.disabledFamilies === undefined) cfg.team.disabledFamilies = [];

  if (cfg.quota.allowUnknownGpt === undefined) cfg.quota.allowUnknownGpt = false;
  if (cfg.quota.gptReservePct === undefined) cfg.quota.gptReservePct = 3;
  if (cfg.gate.sandboxDirectAllow === undefined) cfg.gate.sandboxDirectAllow = true;
  if (cfg.gate.enablePatternCache === undefined) cfg.gate.enablePatternCache = true;
  if (cfg.gate.dedupeDeniedCalls === undefined) cfg.gate.dedupeDeniedCalls = true;
  if (cfg.gate.maxReviewsPerMember === undefined) cfg.gate.maxReviewsPerMember = null;
  if (cfg.gate.maxDenialsPerMember === undefined) cfg.gate.maxDenialsPerMember = 10;
  if (cfg.gate.maxReviewsPerTask === undefined) cfg.gate.maxReviewsPerTask = null;
  if (cfg.gate.ruleOnlyTools === undefined) cfg.gate.ruleOnlyTools = [];
  if (cfg.gate.maxConsecutiveGateErrors === undefined) cfg.gate.maxConsecutiveGateErrors = 5;
  if (cfg.gate.gateErrorCooldownMs === undefined) cfg.gate.gateErrorCooldownMs = 60000;
  if (cfg.team.leaderModelAsLastResort === undefined) cfg.team.leaderModelAsLastResort = true;
  if (cfg.paths.leaderReadRoots === undefined) cfg.paths.leaderReadRoots = [];
  const memberToolUnion = new Set(memberProfiles.flatMap(id => profiles[id].tools));
  cfg.derived = {
    memberProfiles,
    leaderOnlyTools: profiles.leader.tools.filter(x => !memberToolUnion.has(x)),
  };
  return deepFreeze(cfg);
}
export function routeProvider(route) { return route.slice(0, route.indexOf('/')); }
export function routeModel(route) { return route.slice(route.indexOf('/') + 1); }
