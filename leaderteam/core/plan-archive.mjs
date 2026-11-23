// Fixed-external-path historical plan classification, archival, anti-stagnation best-plan
// selection, post-execution retrospective (`复审`), and safe cleanup.
// HARD INVARIANT: Plans are NEVER stored inside a project workspace (`cwd`) or source repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LtError, PLAN_CATEGORIES } from './constants.mjs';
import { resolvePath, isInside, realpathBestEffort, pathKey } from './paths.mjs';
import { appendJsonl, readJsonl, writeFileAtomic, safeId } from './store.mjs';
import { extractJsonObjectText } from './gate-policy.mjs';
import { truncate } from './redact.mjs';
import { resolveNowMs, formatElapsedDuration } from './timer.mjs';
import { unresolvedHardBlockers } from './review-policy.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_PLAN_ARCHIVE_CONFIG = Object.freeze({
  enabled: true,
  root: null, // defaults to <storageRoot>/plan-archive (strictly outside workspace)
  minUnapprovedPlansForFallback: 3,
  allowAutoFallbackOnDispatch: false,
  useArbiterForBestPlan: true,
});

const CATEGORY_RULES = [
  { category: 'security', re: /\b(?:security|auth|acl|sandbox|permission|secret|redact|csrf|xss|injection|gate|token|privilege)\b|安全|权限|沙箱|脱敏|鉴权|漏洞/giu },
  { category: 'architecture', re: /\b(?:architect\w*|plugin\w*|modular\w*|protocol|schema|contract|boundary|broker|service\w*|decoupl\w*)\b|架构|插件|解耦|协议|边界|拆分/giu },
  { category: 'bugfix', re: /\b(?:bug\w*|fix\w*|regress\w*|crash\w*|race|deadlock|broken|repair|hotfix|patch)\b|修复|故障|崩溃|竞态|死锁|回退|问题/giu },
  { category: 'performance', re: /\b(?:perf\w*|latenc\w*|throughput|cache|memory|cpu|concurren\w*|optimiz\w*|bottleneck)\b|性能|并发|内存|延迟|吞吐|缓存|优化/giu },
  { category: 'refactor', re: /\b(?:refactor\w*|cleanup|restructur\w*|simplif\w*|extract\w*|migrate|renam\w*)\b|重构|整理|迁移|抽离|精简/giu },
  { category: 'testing', re: /\b(?:test\w*|spec\w*|assert\w*|verif\w*|adversar\w*|benchmark|e2e|unit|integration)\b|测试|验收|对抗|断言|复验/giu },
  { category: 'docs', re: /\b(?:readme|doc\w*|guide|runbook|manual|changelog)\b|文档|说明|手册|总览/giu },
  { category: 'ops', re: /\b(?:deploy\w*|install\w*|shortcut|backup|bundle|release|ci|packaging)\b|部署|安装|备份|发布|打包|运维/giu },
  { category: 'feature', re: /\b(?:implement\w*|add\w*|build\w*|create\w*|support\w*|ui|panel|timer|archive|dashboard)\b|新增|实现|功能|面板|计时器|归档/giu },
];

export function computeProjectKey(workspacePath, platform = process.platform) {
  const resolved = workspacePath ? resolvePath(workspacePath, undefined, platform) : null;
  const keySource = resolved ? pathKey(resolved, platform) : 'unknown-workspace';
  const baseName = resolved
    ? path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'proj'
    : 'proj';
  const hash = crypto.createHash('sha256').update(keySource).digest('hex').slice(0, 12);
  return `${baseName}-${hash}`;
}

/**
 * Resolve and validate the fixed external archive root.
 * Strictly rejects any path inside `workspaceRoot` or inside the LeaderTeam source repository
 * (except `<repoRoot>/test-work/...` or `<repoRoot>/scratch/...` used by isolated automated tests).
 */
export function resolvePlanArchiveRoot({
  config,
  storageRoot,
  workspaceRoot = null,
  repoRoot = DEFAULT_REPO_ROOT,
  platform = process.platform,
} = {}) {
  const configuredRoot = config?.planArchive?.root ?? null;
  let rawTarget = null;
  if (typeof configuredRoot === 'string' && configuredRoot.trim() !== '') {
    rawTarget = configuredRoot.trim();
  } else if (typeof process.env.LEADERTEAM_PLAN_ARCHIVE_ROOT === 'string' && process.env.LEADERTEAM_PLAN_ARCHIVE_ROOT.trim() !== '') {
    rawTarget = process.env.LEADERTEAM_PLAN_ARCHIVE_ROOT.trim();
  } else if (typeof storageRoot === 'string' && storageRoot.trim() !== '') {
    rawTarget = path.join(storageRoot, 'plan-archive');
  }

  if (!rawTarget) {
    throw new LtError('PLAN_ARCHIVE_PATH', 'cannot resolve fixed external plan archive root (storageRoot and planArchive.root are both unset)');
  }
  const resolved = resolvePath(rawTarget, undefined, platform);
  if (!resolved) {
    throw new LtError('PLAN_ARCHIVE_PATH', `planArchive.root must be a fixed absolute path outside the project: "${rawTarget}"`);
  }
  assertArchiveOutsideProject(resolved, { workspaceRoot, repoRoot, platform });
  return resolved;
}

export function assertArchiveOutsideProject(archiveRoot, {
  workspaceRoot = null,
  repoRoot = DEFAULT_REPO_ROOT,
  platform = process.platform,
} = {}) {
  const resolvedArchive = resolvePath(archiveRoot, undefined, platform);
  if (!resolvedArchive) {
    throw new LtError('PLAN_ARCHIVE_PATH', `invalid plan archive path: ${archiveRoot}`);
  }
  const realOf = p => (platform === process.platform ? realpathBestEffort(p, platform) : p);
  const realArchive = realOf(resolvedArchive);

  if (workspaceRoot) {
    const ws = resolvePath(workspaceRoot, undefined, platform);
    if (ws) {
      const realWs = realOf(ws);
      if (isInside(resolvedArchive, ws, platform) || isInside(realArchive, realWs, platform)) {
        throw new LtError(
          'PLAN_ARCHIVE_INSIDE_PROJECT',
          `plan archive root "${resolvedArchive}" is inside project workspace "${ws}"; plans must be stored at a fixed external path for clean management`,
        );
      }
    }
  }

  if (repoRoot) {
    const repo = resolvePath(repoRoot, undefined, platform);
    if (repo) {
      const realRepo = realOf(repo);
      const allowedEphemeral = [
        resolvePath('test-work', repo, platform),
        resolvePath('scratch', repo, platform),
      ].filter(Boolean);
      const realAllowedEphemeral = allowedEphemeral.map(realOf);
      const inEphemeral = allowedEphemeral.some(a => isInside(resolvedArchive, a, platform))
        || realAllowedEphemeral.some(a => isInside(realArchive, a, platform));
      if (!inEphemeral && (isInside(resolvedArchive, repo, platform) || isInside(realArchive, realRepo, platform))) {
        throw new LtError(
          'PLAN_ARCHIVE_INSIDE_PROJECT',
          `plan archive root "${resolvedArchive}" is inside repository "${repo}"; configure a fixed external path outside the project`,
        );
      }
    }
  }
  return resolvedArchive;
}

export const assertExternalArchiveRoot = assertArchiveOutsideProject;

export function classifyPlanProposal({ topic = '', proposal = '', userRequest = '', explicitCategory = null } = {}) {
  if (explicitCategory && PLAN_CATEGORIES.includes(explicitCategory)) {
    return { category: explicitCategory, matchedCategories: [explicitCategory], tags: extractPlanTags(topic, proposal) };
  }
  const hay = `${topic}\n${proposal}\n${userRequest}`;
  const scores = [];
  for (const rule of CATEGORY_RULES) {
    rule.re.lastIndex = 0;
    const matches = hay.match(rule.re);
    if (matches && matches.length > 0) {
      scores.push({ category: rule.category, count: matches.length });
    }
  }
  scores.sort((a, b) => b.count - a.count);
  const primary = scores[0]?.category ?? 'general';
  const matchedCategories = scores.length > 0 ? scores.slice(0, 3).map(s => s.category) : ['general'];
  return {
    category: primary,
    matchedCategories,
    tags: extractPlanTags(topic, proposal),
  };
}

export function classifyPlanCategory(opts = {}) {
  return classifyPlanProposal(opts).category;
}

function extractPlanTags(topic, proposal) {
  const tags = new Set();
  const text = `${topic}\n${proposal}`;
  if (/\b(?:shell|pwsh|bash)\b/i.test(text)) tags.add('shell');
  if (/\b(?:readonly|scout)\b|只读/iu.test(text)) tags.add('readonly-scout');
  if (/\b(?:parallel|concurrent|wave)\b|并行|多成员/iu.test(text)) tags.add('parallel');
  const globs = text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_*.-]+)+/g) ?? [];
  for (const g of globs.slice(0, 5)) {
    const top = g.split('/')[0];
    if (top && top.length <= 24 && !top.startsWith('.')) tags.add(`scope:${top}`);
  }
  return [...tags].slice(0, 8);
}

function renderPlanMarkdown(plan) {
  const lines = [
    `# Archived Plan ${plan.planId}`,
    '',
    `- **Agreement ID**: \`${plan.agreementId ?? 'N/A'}\``,
    `- **Category**: \`${plan.category}\` (${(plan.matchedCategories ?? []).join(', ')})`,
    `- **Lifecycle State**: \`${plan.lifecycleState}\``,
    `- **Project Key**: \`${plan.projectKey}\``,
    `- **Workspace**: \`${plan.workspace ?? 'N/A'}\``,
    `- **Team / Task**: \`${plan.teamId}\` / task \`#${plan.taskSeq}\``,
    `- **Created / Updated**: \`${plan.createdAt}\` / \`${plan.updatedAt}\``,
    ...(plan.revises ? [`- **Revises**: \`${plan.revises}\``] : []),
    ...(plan.timerSnapshot ? [`- **Engineering Timer at Review**: ${plan.timerSnapshot.summary ?? ''}`] : []),
    '',
    `## Topic`,
    plan.topic || '(untitled)',
    '',
    `## User Request`,
    plan.userRequest || '(empty)',
    '',
    `## Proposal`,
    plan.proposal || '(empty)',
    '',
  ];
  if (plan.outcome) {
    lines.push(
      `## Review Outcome`,
      `- Decision: \`${plan.outcome.decision}\` (by \`${plan.outcome.by}\`, round ${plan.outcome.round}${plan.outcome.adopted ? `, adopted ${plan.outcome.adopted}` : ''})`,
    );
    if (plan.outcome.reasons?.length) {
      lines.push(`- Reasons:`, ...plan.outcome.reasons.map(r => `  - ${r}`));
    }
    if (plan.outcome.suggestions?.length) {
      lines.push(`- Suggestions / Solutions:`, ...plan.outcome.suggestions.map(s => `  - ${s}`));
    }
    if (plan.outcome.requiredChanges?.length) {
      lines.push(`- Required Changes:`, ...plan.outcome.requiredChanges.map(c => `  - ${c}`));
    }
    lines.push('');
  }
  if (plan.fallbackSelection) {
    lines.push(
      `## Anti-Stagnation Best-Plan Selection`,
      `- Selected At: \`${plan.fallbackSelection.selectedAt}\` (by \`${plan.fallbackSelection.by}\`)`,
      `- Rationale: ${plan.fallbackSelection.rationale}`,
      '',
    );
  }
  if (plan.execution?.members?.length) {
    lines.push(
      `## Linked Execution Members`,
      ...plan.execution.members.map(m => `- \`${m.name}\` (\`${m.childId}\`, ${m.model} ${m.effort}, profile=${m.profile}): status=\`${m.status}\`${m.error ? ` — error: ${m.error}` : ''}`),
      '',
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Score candidate plans for anti-stagnation best-plan selection.
 * SAFETY GUARD: A plan that was UNANIMOUSLY `reject`ed (`A=reject` and `B=reject` in its final round,
 * with zero `approve` or `revise` stances) is flagged `unanimouslyRejected = true` and CANNOT be
 * auto-promoted as a fallback execution plan, preventing genuinely broken/dangerous proposals from
 * bypassing consensus under time pressure.
 */
export function rankCandidatePlans(plans = []) {
  const scored = [];
  for (const p of plans) {
    if (!p || typeof p !== 'object') continue;
    const rounds = Array.isArray(p.rounds) ? p.rounds : [];
    const lastRound = rounds.at(-1) ?? null;
    const stances = [lastRound?.A?.stance, lastRound?.B?.stance].filter(Boolean);
    const approveVotes = stances.filter(s => s === 'approve').length;
    const reviseVotes = stances.filter(s => s === 'revise').length;
    const rejectVotes = stances.filter(s => s === 'reject').length;
    const decision = p.outcome?.decision ?? null;

    const unanimouslyRejected = (decision === 'reject' && approveVotes === 0 && reviseVotes === 0)
      || (stances.length >= 2 && rejectVotes === stances.length);

    const reqChangesCount = Array.isArray(p.outcome?.requiredChanges)
      ? p.outcome.requiredChanges.length
      : 0;
    const hasConcreteStructure = /(?:write_scope|acceptance|test|src\/|\.py|\.mjs|\.ts|\.js)/i.test(p.proposal ?? '');
    const revisionBonus = Math.min(3, Number(p.revisionDepth ?? (p.revises ? 1 : 0))) * 8;

    let score = 50;
    if (decision === 'approve') score += 100;
    score += approveVotes * 30;
    score += reviseVotes * 15;
    score -= rejectVotes * 25;
    score -= Math.min(40, reqChangesCount * 6);
    if (hasConcreteStructure) score += 10;
    score += revisionBonus;
    if (unanimouslyRejected) score -= 200;

    scored.push({
      planId: p.planId,
      agreementId: p.agreementId,
      topic: p.topic,
      category: p.category,
      decision,
      approveVotes,
      reviseVotes,
      rejectVotes,
      requiredChangesCount: reqChangesCount,
      unanimouslyRejected,
      unresolvedHardBlockers: unresolvedHardBlockers(p),
      viableForFallback: !unanimouslyRejected && unresolvedHardBlockers(p).length === 0 && (decision === 'approve' || decision === 'revise' || approveVotes > 0 || reviseVotes > 0),
      score,
      plan: p,
    });
  }
  scored.sort((a, b) => {
    if (a.viableForFallback !== b.viableForFallback) return a.viableForFallback ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return String(b.plan.createdAt ?? '').localeCompare(String(a.plan.createdAt ?? ''));
  });
  return scored;
}

export const BEST_PLAN_ARBITER_SYSTEM = [
  'You are the independent arbiter for engineering anti-stagnation best-plan selection. Multiple plan submissions for the current task were turned back and engineering time has exceeded the stagnation threshold.',
  'Select the single most executable, lowest-risk candidate plan from `candidates` that best satisfies `user_request` while Incorporating the reviewers\' constructive `suggestions` and `required_changes` as execution guardrails.',
  'Never invent an unlisted id. Reply with exactly one JSON object: {"selected_plan_id":"<id from candidates>","rationale":"<= 300 chars","execution_guardrails":["..."]}.',
].join('\n');

export function buildBestPlanSelectionRequest({ userRequest = '', timerSnapshot = null, rankedCandidates = [] }) {
  const viable = rankedCandidates.filter(c => c.viableForFallback);
  const payload = {
    user_request: truncate(userRequest, 8000),
    project_timer: timerSnapshot,
    candidates: viable.map(c => ({
      plan_id: c.planId,
      agreement_id: c.agreementId,
      category: c.category,
      heuristic_score: c.score,
      topic: c.topic,
      proposal: truncate(c.plan.proposal ?? '', 8000),
      outcome: c.plan.outcome ?? null,
    })),
  };
  return { system: BEST_PLAN_ARBITER_SYSTEM, user: JSON.stringify(payload, null, 1) };
}

export function parseBestPlanSelection(text, allowedIds = []) {
  const allowed = new Set(allowedIds);
  let v;
  try { v = JSON.parse(extractJsonObjectText(text)); } catch { return { ok: false, error: 'selection is not a JSON object' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'selection is not a JSON object' };
  if (typeof v.selected_plan_id !== 'string' || !allowed.has(v.selected_plan_id)) {
    return { ok: false, error: `selected_plan_id must be one of: ${[...allowed].join(', ')}` };
  }
  if (typeof v.rationale !== 'string' || v.rationale.trim().length < 4) {
    return { ok: false, error: 'rationale must be a non-empty explanation' };
  }
  const guardrails = Array.isArray(v.execution_guardrails)
    ? v.execution_guardrails.filter(s => typeof s === 'string' && s.trim() !== '').slice(0, 12).map(s => truncate(s.trim(), 400))
    : [];
  return {
    ok: true,
    verdict: {
      selectedPlanId: v.selected_plan_id,
      rationale: truncate(v.rationale.trim(), 300),
      executionGuardrails: guardrails,
    },
  };
}

export class PlanArchiveStore {
  constructor(archiveRoot, { workspaceRoot = null, repoRoot = DEFAULT_REPO_ROOT, platform = process.platform } = {}) {
    this.platform = platform;
    this.repoRoot = repoRoot;
    this.root = assertArchiveOutsideProject(archiveRoot, { workspaceRoot, repoRoot, platform });
    this.indexFile = path.join(this.root, 'index.jsonl');
    this.plansDir = path.join(this.root, 'plans');
    this.categoriesDir = path.join(this.root, 'by-category');
    this.projectsDir = path.join(this.root, 'projects');
    this.retrospectivesDir = path.join(this.root, 'retrospectives');
  }

  assertSafeForWorkspace(workspaceRoot) {
    assertArchiveOutsideProject(this.root, { workspaceRoot, repoRoot: this.repoRoot, platform: this.platform });
  }

  projectMetaPath(projectKey) {
    return path.join(this.projectsDir, safeId(projectKey), 'project.json');
  }

  readProjectMeta(workspaceRoot) {
    const projectKey = computeProjectKey(workspaceRoot, this.platform);
    const file = this.projectMetaPath(projectKey);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  touchProjectTimer({ workspaceRoot, teamId, teamActiveMs = 0, nowMs = resolveNowMs() }) {
    if (workspaceRoot) this.assertSafeForWorkspace(workspaceRoot);
    const projectKey = computeProjectKey(workspaceRoot, this.platform);
    const file = this.projectMetaPath(projectKey);
    const existing = this.readProjectMeta(workspaceRoot);
    const nowIso = new Date(nowMs).toISOString();
    const firstStartedAtMs = existing?.firstStartedAtMs
      ? Math.min(existing.firstStartedAtMs, nowMs)
      : nowMs;
    const teamActives = { ...(existing?.teamActiveBySession ?? {}) };
    if (teamId) {
      teamActives[teamId] = Math.max(teamActives[teamId] ?? 0, Math.max(0, Math.trunc(teamActiveMs)));
    }
    const totalActiveMs = Object.values(teamActives).reduce((a, b) => a + (Number(b) || 0), 0);
    const next = {
      v: 1,
      projectKey,
      workspace: workspaceRoot ?? existing?.workspace ?? null,
      firstStartedAtMs,
      firstStartedAt: new Date(firstStartedAtMs).toISOString(),
      updatedAt: nowIso,
      totalActiveMs,
      teamActiveBySession: teamActives,
    };
    writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  planJsonPath(planId) {
    return path.join(this.plansDir, `${safeId(planId)}.json`);
  }

  planMarkdownPath(planId) {
    return path.join(this.plansDir, `${safeId(planId)}.md`);
  }

  getPlan(planId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.planJsonPath(planId), 'utf8'));
      const retroIds = parsed?.execution?.retrospectiveIds ?? [];
      if (retroIds.length > 0 && fs.existsSync(this.retrospectivesDir)) {
        parsed.retrospectives = retroIds
          .map(rid => {
            try { return JSON.parse(fs.readFileSync(path.join(this.retrospectivesDir, `${safeId(rid)}.json`), 'utf8')); } catch { return null; }
          })
          .filter(Boolean);
      } else {
        parsed.retrospectives = [];
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Also resolves by agreementId (`agr-...`) when callers pass `agr-...` instead of `plan-...`. */
  resolvePlan(idOrAgreementId) {
    if (!idOrAgreementId || typeof idOrAgreementId !== 'string') return null;
    const direct = this.getPlan(idOrAgreementId);
    if (direct) return direct;
    if (!fs.existsSync(this.plansDir)) return null;
    for (const entry of fs.readdirSync(this.plansDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.plansDir, entry), 'utf8'));
        if (parsed?.agreementId === idOrAgreementId || parsed?.planId === idOrAgreementId) {
          return this.getPlan(parsed.planId) ?? parsed;
        }
      } catch {}
    }
    return null;
  }

  savePlan(record, { appendIndex = true } = {}) {
    if (record.workspace) this.assertSafeForWorkspace(record.workspace);
    fs.mkdirSync(this.plansDir, { recursive: true });
    const snapshot = JSON.stringify(record, null, 2) + '\n';
    const snapshotDir = path.join(this.plansDir, 'snapshots', safeId(record.planId));
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotFile = path.join(snapshotDir, crypto.createHash('sha256').update(snapshot).digest('hex') + '.json');
    try { fs.writeFileSync(snapshotFile, snapshot, { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (fs.readFileSync(snapshotFile, 'utf8') !== snapshot) throw new Error('immutable plan snapshot integrity failure'); }
    writeFileAtomic(this.planJsonPath(record.planId), JSON.stringify(record, null, 2) + '\n');
    writeFileAtomic(this.planMarkdownPath(record.planId), renderPlanMarkdown(record));
    if (appendIndex) {
      const summaryRow = {
        v: 1,
        at: record.updatedAt,
        planId: record.planId,
        agreementId: record.agreementId,
        projectKey: record.projectKey,
        workspace: record.workspace,
        teamId: record.teamId,
        taskSeq: record.taskSeq,
        category: record.category,
        lifecycleState: record.lifecycleState,
        decision: record.outcome?.decision ?? null,
        topic: record.topic,
      };
      appendJsonl(this.indexFile, summaryRow);
      const catFile = path.join(this.categoriesDir, safeId(record.category || 'general'), 'index.jsonl');
      appendJsonl(catFile, summaryRow);
    }
    return record;
  }

  archivePlanSubmission({
    agreementId,
    teamId,
    taskSeq = 1,
    workspace = null,
    topic = '',
    proposal = '',
    userRequest = '',
    evidenceSummary = '',
    revises = null,
    explicitCategory = null,
    timerSnapshot = null,
    nowMs = resolveNowMs(),
  }) {
    if (workspace) this.assertSafeForWorkspace(workspace);
    const planId = agreementId ? safeId(agreementId) : `plan-${crypto.randomUUID().slice(0, 8)}`;
    const existing = this.getPlan(planId);
    if (existing) return existing;

    const projectKey = computeProjectKey(workspace, this.platform);
    const classification = classifyPlanProposal({ topic, proposal, userRequest, explicitCategory });
    let revisionDepth = 0;
    if (revises) {
      const prev = this.resolvePlan(revises);
      if (prev) {
        revisionDepth = (prev.revisionDepth ?? 0) + 1;
        if (prev.lifecycleState !== 'executed' && prev.lifecycleState !== 'retrospected') {
          prev.lifecycleState = 'superseded';
          prev.supersededBy = planId;
          prev.updatedAt = new Date(nowMs).toISOString();
          this.savePlan(prev, { appendIndex: true });
        }
      } else {
        revisionDepth = 1;
      }
    }
    const nowIso = new Date(nowMs).toISOString();
    const record = {
      v: 1,
      planId,
      agreementId: agreementId ?? planId,
      projectKey,
      workspace,
      teamId,
      taskSeq,
      category: classification.category,
      matchedCategories: classification.matchedCategories,
      tags: classification.tags,
      lifecycleState: 'open',
      topic: truncate(topic, 300),
      userRequest: truncate(userRequest, 12000),
      proposal,
      evidenceSummary: truncate(evidenceSummary, 4000),
      revises: revises ?? null,
      supersededBy: null,
      revisionDepth,
      timerSnapshot,
      rounds: [],
      outcome: null,
      fallbackSelection: null,
      execution: {
        members: [],
        deliveryAgreements: [],
        retrospectiveIds: [],
      },
      createdAt: nowIso,
      createdAtMs: nowMs,
      updatedAt: nowIso,
    };
    return this.savePlan(record, { appendIndex: true });
  }

  recordPlanReviewSettlement(planIdOrAgreementId, state, { nowMs = resolveNowMs() } = {}) {
    const plan = this.resolvePlan(planIdOrAgreementId);
    if (!plan || !state) return null;
    plan.rounds = (state.rounds ?? []).map(r => ({
      round: r.n,
      A: r.A ? {
        stance: r.A.stance,
        summary: r.A.summary,
        reasons: [...(r.A.reasons ?? [])],
        suggestions: [...(r.A.suggestions ?? [])],
        requiredChanges: [...(r.A.requiredChanges ?? [])],
        changeItems: structuredClone(r.A.changeItems ?? []), conditions:[...(r.A.conditions ?? [])],
      } : null,
      B: r.B ? {
        stance: r.B.stance,
        summary: r.B.summary,
        reasons: [...(r.B.reasons ?? [])],
        suggestions: [...(r.B.suggestions ?? [])],
        requiredChanges: [...(r.B.requiredChanges ?? [])],
        changeItems: structuredClone(r.B.changeItems ?? []), conditions:[...(r.B.conditions ?? [])],
      } : null,
    }));
    if (state.outcome) {
      plan.outcome = {
        decision: state.outcome.decision,
        by: state.outcome.by,
        round: state.outcome.round,
        ...(state.outcome.adopted ? { adopted: state.outcome.adopted } : {}),
        reasons: [...(state.outcome.reasons ?? [])],
        suggestions: [...(state.outcome.suggestions ?? [])],
        requiredChanges: [...(state.outcome.requiredChanges ?? [])],
        changeItems: structuredClone(state.outcome.changeItems ?? []), conditions:[...(state.outcome.conditions ?? [])],
      };
      if (plan.supersededBy) {
        plan.lifecycleState = 'superseded';
      } else if (state.outcome.decision === 'approve') {
        plan.lifecycleState = 'approved';
      } else if (state.outcome.decision === 'revise') {
        plan.lifecycleState = 'revised';
      } else if (state.outcome.decision === 'reject') {
        plan.lifecycleState = 'rejected';
      }
    }
    plan.updatedAt = new Date(nowMs).toISOString();
    return this.savePlan(plan, { appendIndex: true });
  }

  markFallbackSelected(planIdOrAgreementId, { by = 'heuristic', rationale = '', executionGuardrails = [], nowMs = resolveNowMs() } = {}) {
    const plan = this.resolvePlan(planIdOrAgreementId);
    if (!plan) return null;
    const nowIso = new Date(nowMs).toISOString();
    plan.lifecycleState = 'selected_best_fallback';
    plan.fallbackSelection = {
      selectedAt: nowIso,
      selectedAtMs: nowMs,
      by,
      rationale,
      executionGuardrails,
    };
    plan.updatedAt = nowIso;
    return this.savePlan(plan, { appendIndex: true });
  }

  recordMemberLinked(planIdOrAgreementId, memberSummary, { nowMs = resolveNowMs() } = {}) {
    const plan = this.resolvePlan(planIdOrAgreementId);
    if (!plan || !memberSummary?.childId) return null;
    plan.execution ??= { members: [], deliveryAgreements: [], retrospectiveIds: [] };
    const idx = plan.execution.members.findIndex(m => m.childId === memberSummary.childId);
    const entry = {
      childId: memberSummary.childId,
      name: memberSummary.name,
      profile: memberSummary.profile,
      model: memberSummary.model,
      effort: memberSummary.effort,
      writeScope: [...(memberSummary.writeScope ?? [])],
      status: memberSummary.status ?? 'started',
      ...(memberSummary.error ? { error: memberSummary.error } : {}),
      updatedAt: new Date(nowMs).toISOString(),
    };
    if (idx >= 0) plan.execution.members[idx] = { ...plan.execution.members[idx], ...entry };
    else plan.execution.members.push(entry);
    if (plan.lifecycleState === 'approved' || plan.lifecycleState === 'selected_best_fallback') {
      plan.lifecycleState = 'executed';
    }
    plan.updatedAt = new Date(nowMs).toISOString();
    return this.savePlan(plan, { appendIndex: false });
  }

  syncTeamExecutionOutcomes(teamId, taskSeq, teamStoreInstance, { nowMs = resolveNowMs() } = {}) {
    const plans = this.listPlans({ teamId, taskSeq, limit: 100 });
    if (plans.length === 0 || !teamStoreInstance) return;
    const membersById = teamStoreInstance.members();
    for (const summary of plans) {
      const full = this.getPlan(summary.planId);
      if (!full) continue;
      let dirty = false;
      for (const m of membersById.values()) {
        if (m.planId !== full.planId && m.planId !== full.agreementId) continue;
        const existing = full.execution?.members?.find(x => x.childId === m.childId);
        if (!existing || existing.status !== m.status || existing.error !== m.error) {
          this.recordMemberLinked(full.planId, m, { nowMs });
          dirty = true;
        }
      }
      if (dirty) full.updatedAt = new Date(nowMs).toISOString();
    }
  }

  recordDeliveryOutcome({ teamId, taskSeq, deliveryAgreementId, outcome, nowMs = resolveNowMs() }) {
    const plans = this.listPlans({ teamId, taskSeq, limit: 50 });
    for (const p of plans) {
      const full = this.getPlan(p.planId);
      if (!full) continue;
      if (!['approved', 'selected_best_fallback', 'executed', 'retrospected'].includes(full.lifecycleState)) continue;
      full.execution ??= { members: [], deliveryAgreements: [], retrospectiveIds: [] };
      const idx = full.execution.deliveryAgreements.findIndex(d => d.agreementId === deliveryAgreementId);
      const rec = {
        agreementId: deliveryAgreementId,
        decision: outcome?.decision ?? null,
        by: outcome?.by ?? null,
        reasons: [...(outcome?.reasons ?? [])],
        suggestions: [...(outcome?.suggestions ?? [])],
        requiredChanges: [...(outcome?.requiredChanges ?? [])],
        recordedAt: new Date(nowMs).toISOString(),
      };
      if (idx >= 0) full.execution.deliveryAgreements[idx] = rec;
      else full.execution.deliveryAgreements.push(rec);
      full.updatedAt = new Date(nowMs).toISOString();
      this.savePlan(full, { appendIndex: false });
    }
  }

  listPlans({
    projectKey = null,
    workspace = null,
    teamId = null,
    taskSeq = null,
    category = null,
    lifecycleState = null,
    limit = 50,
  } = {}) {
    if (!fs.existsSync(this.plansDir)) return [];
    const wantProj = projectKey ?? (workspace ? computeProjectKey(workspace, this.platform) : null);
    const out = [];
    for (const entry of fs.readdirSync(this.plansDir)) {
      if (!entry.endsWith('.json')) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(this.plansDir, entry), 'utf8')); } catch { continue; }
      if (wantProj && p.projectKey !== wantProj) continue;
      if (teamId && p.teamId !== teamId) continue;
      if (taskSeq !== null && taskSeq !== undefined && p.taskSeq !== taskSeq) continue;
      if (category && p.category !== category) continue;
      if (lifecycleState && p.lifecycleState !== lifecycleState) continue;
      out.push({
        planId: p.planId,
        agreementId: p.agreementId,
        projectKey: p.projectKey,
        projectLabel: p.workspace ? path.basename(p.workspace) : p.projectKey,
        workspace: p.workspace,
        teamId: p.teamId,
        taskSeq: p.taskSeq,
        category: p.category,
        matchedCategories: p.matchedCategories ?? [p.category],
        tags: p.tags ?? [],
        lifecycleState: p.lifecycleState,
        topic: p.topic,
        revises: p.revises,
        supersededBy: p.supersededBy,
        revisionDepth: p.revisionDepth ?? 0,
        decision: p.outcome?.decision ?? null,
        fallbackSelected: Boolean(p.fallbackSelection),
        memberCount: p.execution?.members?.length ?? 0,
        retrospectiveCount: p.execution?.retrospectiveIds?.length ?? 0,
        createdAt: p.createdAt,
        createdAtMs: p.createdAtMs ?? 0,
        updatedAt: p.updatedAt,
      });
    }
    out.sort((a, b) => (b.createdAtMs - a.createdAtMs) || String(b.createdAt).localeCompare(String(a.createdAt)));
    return out.slice(0, Math.max(1, Math.min(500, limit)));
  }

  /**
   * Build a post-execution retrospective (`复审`) pinpointing where execution or planning went wrong
   * (or succeeded), linking plan review warnings, member failures/blocks, safety-gate denials, and delivery feedback.
   */
  createRetrospective(planIdOrAgreementId, {
    teamStoreInstance = null,
    notes = '',
    nowMs = resolveNowMs(),
  } = {}) {
    const plan = this.resolvePlan(planIdOrAgreementId);
    if (!plan) throw new LtError('PLAN_NOT_FOUND', `archived plan not found: ${planIdOrAgreementId}`);
    if (teamStoreInstance) {
      this.syncTeamExecutionOutcomes(plan.teamId, plan.taskSeq, teamStoreInstance, { nowMs });
    }
    const refreshed = this.getPlan(plan.planId) ?? plan;
    const members = refreshed.execution?.members ?? [];
    const failedMembers = members.filter(m => m.status === 'failed' || m.status === 'blocked' || m.status === 'cancelled');
    const succeededMembers = members.filter(m => m.status === 'done');

    let gateDenials = [];
    let gateAllowedCount = 0;
    if (teamStoreInstance) {
      const memberIds = new Set(members.map(m => m.childId));
      const receipts = teamStoreInstance.gateReceipts().filter(r =>
        (r.taskSeq ?? 1) === refreshed.taskSeq && (memberIds.size === 0 || memberIds.has(r.agentId) || r.role === 'leader'),
      );
      gateAllowedCount = receipts.filter(r => r.decision === 'allow').length;
      gateDenials = receipts
        .filter(r => r.decision === 'deny')
        .map(r => ({
          at: r.at,
          member: r.member ?? r.role,
          tool: r.tool,
          by: r.by,
          reason: r.reason,
        }));
    }

    const deliveries = refreshed.execution?.deliveryAgreements ?? [];
    const unapprovedDeliveries = deliveries.filter(d => d.decision !== 'approve');
    const issues = [];

    if (refreshed.fallbackSelection) {
      issues.push({
        stage: 'planning',
        severity: 'warning',
        summary: `Plan entered execution via anti-stagnation best-plan fallback (${refreshed.fallbackSelection.by})`,
        detail: refreshed.fallbackSelection.rationale,
      });
    }
    if (refreshed.outcome && refreshed.outcome.decision !== 'approve') {
      issues.push({
        stage: 'plan-review',
        severity: 'info',
        summary: `Initial review stance was "${refreshed.outcome.decision}"`,
        detail: `Initial review stance was "${refreshed.outcome.decision}"`,
        unresolvedRequiredChanges: refreshed.outcome.requiredChanges ?? [],
        reviewerSuggestions: refreshed.outcome.suggestions ?? [],
      });
    }
    for (const fm of failedMembers) {
      issues.push({
        stage: 'execution',
        severity: 'error',
        member: fm.name,
        model: `${fm.model} (${fm.effort})`,
        profile: fm.profile,
        status: fm.status,
        detail: `Member ${fm.name} (${fm.status}): ${fm.error ?? `ended in non-done status "${fm.status}"`}`,
      });
    }
    if (gateDenials.length > 0) {
      const byRule = {};
      for (const d of gateDenials) byRule[d.by] = (byRule[d.by] ?? 0) + 1;
      const ruleBreakdown = Object.entries(byRule).map(([k, v]) => `${k}=${v}`).join(', ');
      issues.push({
        stage: 'safety-gate',
        severity: gateDenials.length >= 3 ? 'warning' : 'info',
        summary: `${gateDenials.length} tool call(s) were denied by the safety gate`,
        detail: `${gateDenials.length} tool call(s) were denied by the safety gate (${ruleBreakdown})`,
        breakdownByRule: byRule,
        samples: gateDenials.slice(0, 8),
      });
    }
    for (const ud of unapprovedDeliveries) {
      issues.push({
        stage: 'delivery-review',
        severity: 'warning',
        agreementId: ud.agreementId,
        decision: ud.decision,
        detail: `Delivery agreement ${ud.agreementId} returned "${ud.decision}"`,
        reasons: ud.reasons,
        suggestions: ud.suggestions,
        requiredChanges: ud.requiredChanges,
      });
    }
    if (members.length === 0) {
      issues.push({
        stage: 'dispatch',
        severity: 'warning',
        summary: 'No execution members were dispatched under this plan',
        detail: 'No execution members were dispatched under this plan',
      });
    }

    const health = failedMembers.length > 0
      ? 'needs_attention'
      : (unapprovedDeliveries.length > 0 && !deliveries.some(d => d.decision === 'approve'))
        ? 'delivery_rework_needed'
        : (members.length > 0 ? 'healthy' : 'not_executed');
    const hasBlockingIssues = failedMembers.length > 0
      || gateDenials.length > 0
      || (unapprovedDeliveries.length > 0 && !deliveries.some(d => d.decision === 'approve'));
    const verdict = hasBlockingIssues
      ? 'issues-identified'
      : (members.length > 0 ? 'clean-execution' : 'not-executed');

    const retroId = `retro-${refreshed.planId}-${String(nowMs).slice(-6)}`;
    const nowIso = new Date(nowMs).toISOString();
    const retro = {
      v: 1,
      retroId,
      planId: refreshed.planId,
      agreementId: refreshed.agreementId,
      projectKey: refreshed.projectKey,
      workspace: refreshed.workspace,
      teamId: refreshed.teamId,
      taskSeq: refreshed.taskSeq,
      category: refreshed.category,
      createdAt: nowIso,
      health,
      verdict,
      executionSummary: {
        totalMembers: members.length,
        succeededMembers: succeededMembers.length,
        failedOrBlockedMembers: failedMembers.length,
        gateAllowedCalls: gateAllowedCount,
        gateDeniedCalls: gateDenials.length,
        deliveryAttempts: deliveries.length,
        finalDeliveryApproved: deliveries.some(d => d.decision === 'approve'),
      },
      issues,
      findings: issues,
      operatorNotes: notes ? truncate(String(notes), 4000) : '',
    };

    fs.mkdirSync(this.retrospectivesDir, { recursive: true });
    writeFileAtomic(path.join(this.retrospectivesDir, `${safeId(retroId)}.json`), JSON.stringify(retro, null, 2) + '\n');
    const mdLines = [
      `# Plan Retrospective ${retroId}`,
      '',
      `- **Plan ID**: \`${retro.planId}\` (\`${retro.category}\`)`,
      `- **Health**: \`${retro.health}\``,
      `- **Workspace**: \`${retro.workspace ?? 'N/A'}\``,
      `- **Members**: ${retro.executionSummary.succeededMembers}/${retro.executionSummary.totalMembers} succeeded (${retro.executionSummary.failedOrBlockedMembers} failed/blocked)`,
      `- **Safety Gate**: ${retro.executionSummary.gateAllowedCalls} allowed, ${retro.executionSummary.gateDeniedCalls} denied`,
      `- **Delivery Approved**: \`${retro.executionSummary.finalDeliveryApproved}\``,
      '',
      `## Findings (${issues.length})`,
      ...(issues.length
        ? issues.map((iss, i) => `${i + 1}. **[${iss.stage} / ${iss.severity}]** ${iss.summary ?? iss.detail ?? JSON.stringify(iss)}`)
        : ['- No execution, gate, or delivery issues detected.']),
      ...(retro.operatorNotes ? ['', '## Notes', retro.operatorNotes] : []),
      '',
    ];
    writeFileAtomic(path.join(this.retrospectivesDir, `${safeId(retroId)}.md`), mdLines.join('\n'));

    refreshed.execution ??= { members: [], deliveryAgreements: [], retrospectiveIds: [] };
    if (!refreshed.execution.retrospectiveIds.includes(retroId)) {
      refreshed.execution.retrospectiveIds.push(retroId);
    }
    refreshed.lifecycleState = 'retrospected';
    refreshed.updatedAt = nowIso;
    this.savePlan(refreshed, { appendIndex: true });
    return retro;
  }

  getStats() {
    const all = this.listPlans({ limit: 500 });
    const byCategory = {};
    const byState = {};
    const projects = new Set();
    for (const p of all) {
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
      byState[p.lifecycleState] = (byState[p.lifecycleState] ?? 0) + 1;
      if (p.projectKey) projects.add(p.projectKey);
    }
    return {
      root: this.root,
      archiveRoot: this.root,
      totalPlans: all.length,
      projectCount: projects.size,
      byCategory,
      byState,
      byLifecycleState: byState,
      recentPlans: all.slice(0, 10),
    };
  }

  /**
   * Clean archived plans from the fixed external directory (with `dryRun` preview by default).
   */
  clean({
    projectKey = null,
    workspace = null,
    teamId = null,
    category = null,
    olderThanDays = null,
    all = false,
    dryRun = true,
    nowMs = resolveNowMs(),
  } = {}) {
    if (!all && !projectKey && !workspace && !teamId && !category && (olderThanDays === null || olderThanDays === undefined)) {
      throw new LtError('PLAN_ARCHIVE_CLEAN', 'clean requires an explicit filter (projectKey, workspace, teamId, category, olderThanDays) or all=true');
    }
    const wantProj = projectKey ?? (workspace ? computeProjectKey(workspace, this.platform) : null);
    const cutoffMs = (typeof olderThanDays === 'number' && Number.isFinite(olderThanDays) && olderThanDays >= 0)
      ? nowMs - olderThanDays * 86400 * 1000
      : null;

    const matchedPlanIds = [];
    const matchedRetroIds = [];
    const filesToDelete = [];
    const snapshotDirsToDelete = [];

    if (fs.existsSync(this.plansDir)) {
      for (const entry of fs.readdirSync(this.plansDir)) {
        if (!entry.endsWith('.json')) continue;
        const fullPath = path.join(this.plansDir, entry);
        let p;
        try { p = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch { continue; }
        if (wantProj && p.projectKey !== wantProj) continue;
        if (teamId && p.teamId !== teamId) continue;
        if (category && p.category !== category) continue;
        if (cutoffMs !== null && (p.createdAtMs ?? 0) > cutoffMs) continue;

        matchedPlanIds.push(p.planId);
        filesToDelete.push(fullPath);
        const mdPath = this.planMarkdownPath(p.planId);
        if (fs.existsSync(mdPath)) filesToDelete.push(mdPath);
        const snapshotDir = path.join(this.plansDir, 'snapshots', safeId(p.planId));
        if (fs.existsSync(snapshotDir)) {
          const st = fs.lstatSync(snapshotDir);
          if (!st.isDirectory() || st.isSymbolicLink() || !isInside(fs.realpathSync(snapshotDir), fs.realpathSync(this.root), this.platform)) {
            throw new LtError('PLAN_ARCHIVE_CLEAN', `unsafe snapshot directory: ${snapshotDir}`);
          }
          for (const entry of fs.readdirSync(snapshotDir, { withFileTypes: true })) {
            // Enumerate only our immutable snapshot files; never recursively follow links.
            if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) filesToDelete.push(path.join(snapshotDir, entry.name));
          }
          snapshotDirsToDelete.push(snapshotDir);
        }
        for (const rid of p.execution?.retrospectiveIds ?? []) {
          matchedRetroIds.push(rid);
          const rj = path.join(this.retrospectivesDir, `${safeId(rid)}.json`);
          const rm = path.join(this.retrospectivesDir, `${safeId(rid)}.md`);
          if (fs.existsSync(rj)) filesToDelete.push(rj);
          if (fs.existsSync(rm)) filesToDelete.push(rm);
        }
      }
    }

    if (!dryRun) {
      const removedPlanSet = new Set(matchedPlanIds);
      for (const f of filesToDelete) {
        if (isInside(f, this.root, this.platform) && fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      }
      for (const dir of snapshotDirsToDelete) {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      }
      // Rebuild master and category index files excluding removed plans
      if (fs.existsSync(this.indexFile)) {
        const kept = readJsonl(this.indexFile).records.filter(r => !removedPlanSet.has(r.planId));
        writeFileAtomic(this.indexFile, kept.length ? kept.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
      }
      if (fs.existsSync(this.categoriesDir)) {
        for (const cat of fs.readdirSync(this.categoriesDir)) {
          const cf = path.join(this.categoriesDir, cat, 'index.jsonl');
          if (!fs.existsSync(cf)) continue;
          const kept = readJsonl(cf).records.filter(r => !removedPlanSet.has(r.planId));
          writeFileAtomic(cf, kept.length ? kept.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
        }
      }
    }

    return {
      root: this.root,
      archiveRoot: this.root,
      dryRun: Boolean(dryRun),
      matchedCount: matchedPlanIds.length,
      matchedPlans: matchedPlanIds.length,
      matchedRetrospectives: matchedRetroIds.length,
      planIds: matchedPlanIds,
      removedCount: dryRun ? 0 : matchedPlanIds.length,
      deletedFilesCount: dryRun ? 0 : filesToDelete.length,
    };
  }

  cleanPlans(opts = {}) {
    return this.clean(opts);
  }
}

export { formatElapsedDuration };
