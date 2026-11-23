import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configWith } from './helpers.mjs';
import {
  normalizeTimerState,
  advanceTimerActivity,
  recordTimerPlanSubmitted,
  recordTimerPlanSettled,
  computeTimerSnapshot,
  reviewTimerPayload,
} from '../../leaderteam/core/timer.mjs';
import {
  classifyPlanCategory,
  resolvePlanArchiveRoot,
  assertExternalArchiveRoot,
  PlanArchiveStore,
  rankCandidatePlans,
} from '../../leaderteam/core/plan-archive.mjs';
import { TeamStore } from '../../leaderteam/core/store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('engineering timer tracks project wall/active time, task resets, idle caps, and stagnation pressure', () => {
  const cfg = configWith({
    timer: {
      enabled: true,
      elevatedAfterMs: 10 * 60 * 1000,
      stagnationAfterMs: 20 * 60 * 1000,
      idleGapCapMs: 5 * 60 * 1000,
    },
    planArchive: {
      minUnapprovedPlansForFallback: 3,
    },
  });
  const t0 = 1_700_000_000_000;
  let state = normalizeTimerState(null, {
    teamId: 'team-timer-1',
    workspace: path.join(os.tmpdir(), 'lt-timer-ws'),
    taskSeq: 1,
    nowMs: t0,
    seedProjectStartedAtMs: t0 - 15 * 60 * 1000,
    seedPriorActiveMs: 4 * 60 * 1000,
  });

  // Active step +2 min (within 5m idle cap -> full 2m added to active time)
  state = advanceTimerActivity(state, { taskSeq: 1, nowMs: t0 + 2 * 60 * 1000, idleGapCapMs: cfg.timer.idleGapCapMs });
  // Long pause +30 min (exceeds 5m idle cap -> active time adds at most 5m = 7m total, while wall time grows +32m)
  state = advanceTimerActivity(state, { taskSeq: 1, nowMs: t0 + 32 * 60 * 1000, idleGapCapMs: cfg.timer.idleGapCapMs });
  assert.equal(state.teamActiveMs, 7 * 60 * 1000);

  // Three turned-back plans across 22 minutes of task 1 -> critical pressure & stagnation fallback eligible
  for (let i = 1; i <= 3; i++) {
    const now = t0 + (32 + i) * 60 * 1000;
    state = recordTimerPlanSubmitted(state, { taskSeq: 1, nowMs: now, idleGapCapMs: cfg.timer.idleGapCapMs });
    state = recordTimerPlanSettled(state, { taskSeq: 1, planId: `agr-p${i}`, decision: 'revise', nowMs: now + 1000, idleGapCapMs: cfg.timer.idleGapCapMs });
  }
  const snap1 = computeTimerSnapshot(state, cfg, { taskSeq: 1, nowMs: t0 + 36 * 60 * 1000 });
  assert.equal(snap1.time_pressure, 'critical');
  assert.equal(snap1.unapproved_plan_attempts, 3);
  assert.equal(snap1.stagnation_fallback_eligible, true);
  assert.ok(snap1.project_active_ms >= 6 * 60 * 1000, 'combines prior session active time + current session active time');

  const revPayload = reviewTimerPayload(snap1, { pendingPlanAttempt: true });
  assert.equal(revPayload.time_pressure, 'critical');
  assert.match(revPayload.directive, /CRITICAL/);

  // Advancing to Task #2 resets task stagnation while preserving cumulative project timer
  state = advanceTimerActivity(state, { taskSeq: 2, nowMs: t0 + 40 * 60 * 1000, idleGapCapMs: cfg.timer.idleGapCapMs });
  const snap2 = computeTimerSnapshot(state, cfg, { taskSeq: 2, nowMs: t0 + 40 * 60 * 1000 + 5000 });
  assert.equal(snap2.task_seq, 2);
  assert.equal(snap2.unapproved_plan_attempts, 0);
  assert.equal(snap2.stagnation_fallback_eligible, false);
  assert.equal(snap2.time_pressure, 'normal');
  assert.ok(snap2.project_wall_ms >= 55 * 60 * 1000);
});

test('fixed external plan archive strictly rejects paths inside workspace or repository', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-archive-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'my-project');
  const externalStorage = path.join(tmp, 'dsh-external-storage');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(externalStorage, { recursive: true });

  // 1. Inside project workspace -> rejected with PLAN_ARCHIVE_INSIDE_PROJECT
  assert.throws(
    () => assertExternalArchiveRoot(path.join(ws, '.leaderteam', 'plan-archive'), { workspaceRoot: ws, repoRoot: REPO_ROOT }),
    { code: 'PLAN_ARCHIVE_INSIDE_PROJECT' },
  );
  assert.throws(
    () => new PlanArchiveStore(path.join(ws, 'plans'), { workspaceRoot: ws }),
    { code: 'PLAN_ARCHIVE_INSIDE_PROJECT' },
  );

  // 2. Inside LeaderTeam repository -> rejected with PLAN_ARCHIVE_INSIDE_PROJECT
  assert.throws(
    () => assertExternalArchiveRoot(path.join(REPO_ROOT, 'plan-archive-inside-repo'), { workspaceRoot: ws, repoRoot: REPO_ROOT }),
    { code: 'PLAN_ARCHIVE_INSIDE_PROJECT' },
  );

  // 3. Default `<externalStorage>/plan-archive` outside both workspace & repo -> accepted
  const cfg = configWith({ storage: { root: externalStorage } });
  const resolved = resolvePlanArchiveRoot({ config: cfg, storageRoot: externalStorage, workspaceRoot: ws, repoRoot: REPO_ROOT });
  assert.equal(resolved, path.join(externalStorage, 'plan-archive'));
});

test('plan archive classifies plans, links execution outcomes, generates retrospectives, and cleans safely via API & CLI', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-archive-lifecycle-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'workspace-alpha');
  const storageRoot = path.join(tmp, 'lt-storage');
  const archiveRoot = path.join(storageRoot, 'plan-archive');
  fs.mkdirSync(ws, { recursive: true });

  assert.equal(classifyPlanCategory({ topic: 'Fix race condition crash in worker pool', proposal: 'Patch mutex bug' }), 'bugfix');
  assert.equal(classifyPlanCategory({ topic: ' Harden ACL sandbox token check', proposal: 'Prevent privilege escalation' }), 'security');
  assert.equal(classifyPlanCategory({ topic: 'Split monolithic runtime into modular plugins', proposal: 'Cordis architecture' }), 'architecture');

  const archive = new PlanArchiveStore(archiveRoot, { workspaceRoot: ws });
  const teamStore = new TeamStore(storageRoot, 'team-alpha');
  teamStore.ensure({ workspace: ws, surface: 'headless' });

  // Archive 2 candidate plans: p1 (revise with 2 items) and p2 (revise with 1 item, revising p1)
  archive.archivePlanSubmission({
    agreementId: 'agr-a1',
    teamId: 'team-alpha',
    taskSeq: 1,
    workspace: ws,
    topic: 'Refactor parser module',
    proposal: 'Step 1: split lexer and parser into src/lexer.js and src/parser.js.\nStep 2: add unit tests in test/parser.test.js.',
    userRequest: 'Refactor parser module cleanly with tests.',
    nowMs: 1_700_000_010_000,
  });
  archive.recordPlanReviewSettlement('agr-a1', {
    status: 'settled',
    outcome: {
      decision: 'revise',
      by: 'consensus',
      round: 1,
      reasons: ['Missing error recovery behavior', 'Missing edge-case empty input test'],
      suggestions: ['Preserve line/column offsets on SyntaxError', 'Add empty-string test in test/parser.test.js'],
      requiredChanges: ['Specify SyntaxError offsets', 'Add empty input test'],
    },
    rounds: [],
  });

  archive.archivePlanSubmission({
    agreementId: 'agr-a2',
    teamId: 'team-alpha',
    taskSeq: 1,
    workspace: ws,
    topic: 'Refactor parser module v2',
    proposal: 'Step 1: split lexer/parser preserving line/col on SyntaxError.\nStep 2: test empty input and malformed tokens in test/parser.test.js.',
    userRequest: 'Refactor parser module cleanly with tests.',
    revises: 'agr-a1',
    nowMs: 1_700_000_050_000,
  });
  archive.recordPlanReviewSettlement('agr-a2', {
    status: 'settled',
    outcome: {
      decision: 'revise',
      by: 'arbiter',
      adopted: 'A',
      round: 3,
      reasons: ['Unicode surrogate handling could be clearer'],
      suggestions: ['Document UTF-16 code unit indexing in src/lexer.js header'],
      requiredChanges: ['Document UTF-16 indexing'],
    },
    rounds: [],
  });

  const ranked = rankCandidatePlans([archive.getPlan('agr-a1'), archive.getPlan('agr-a2')]);
  assert.equal(ranked[0].planId, 'agr-a2', 'converged revision with fewer remaining changes ranks first');

  // Mark fallback selected, link a member that hits 1 gate denial and fails, then generate retrospective
  archive.markFallbackSelected('agr-a2', {
    by: 'arbiter',
    rationale: 'Best coverage and fewest remaining items.',
    executionGuardrails: ['Document UTF-16 indexing'],
  });
  teamStore.addMember({
    childId: 'child-1',
    name: 'impl-parser',
    taskSeq: 1,
    planId: 'agr-a2',
    profile: 'code',
    model: 'zcode/GLM-5.3-Flash',
    effort: 'high',
    writeScope: ['src/**'],
    refs: [],
    task: 'implement',
    acceptance: ['tests pass'],
    cwd: ws,
  });
  teamStore.setMemberStatus('child-1', 'failed', 'SyntaxError in test runner');
  teamStore.appendGateReceipt({
    callId: 'c1',
    taskSeq: 1,
    member: 'impl-parser',
    agentId: 'child-1',
    tool: 'write',
    opHash: 'h1',
    decision: 'deny',
    by: 'rule:path-outside-write-scope',
    reason: 'test/parser.test.js is outside write_scope ["src/**"]',
  });

  archive.syncTeamExecutionOutcomes('team-alpha', 1, teamStore);
  const retro = archive.createRetrospective('agr-a2', {
    teamStoreInstance: teamStore,
    notes: 'write_scope omitted test/** during dispatch.',
  });
  assert.equal(retro.verdict, 'issues-identified');
  assert.ok(retro.findings.some(f => f.stage === 'execution' && f.detail.includes('impl-parser')));
  assert.ok(retro.findings.some(f => f.stage === 'safety-gate' && f.detail.includes('path-outside-write-scope')));
  assert.equal(fs.existsSync(path.join(ws, 'plan-archive')), false, 'zero archive files inside workspace');

  // Exercise scripts/plan-archive.mjs CLI (--status, --list, --clean --dry-run, --clean --all --confirm)
  const cfgPath = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), 'utf8')),
    storage: { root: storageRoot },
  }, null, 2));
  const cliScript = path.join(REPO_ROOT, 'scripts', 'plan-archive.mjs');

  const listOut = JSON.parse(execFileSync(process.execPath, [cliScript, '--config', cfgPath, '--list', '--json'], { encoding: 'utf8' }));
  assert.equal(listOut.count, 2);

  // Unscoped clean without filter fails safely
  assert.throws(() => execFileSync(process.execPath, [cliScript, '--config', cfgPath, '--clean', '--confirm'], { encoding: 'utf8', stdio: 'pipe' }));

  const preview = JSON.parse(execFileSync(process.execPath, [cliScript, '--config', cfgPath, '--clean', '--all', '--dry-run', '--json'], { encoding: 'utf8' }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.matchedCount, 2);
  assert.equal(archive.listPlans().length, 2, 'dry-run removed nothing');
  const snapshotRoot = path.join(archive.plansDir, 'snapshots');
  const snapshotDirs = fs.readdirSync(snapshotRoot);
  assert.equal(snapshotDirs.length, 2, 'dry-run preserves both plans and their immutable history');
  assert.ok(snapshotDirs.every(d => fs.readdirSync(path.join(snapshotRoot, d)).length > 0));

  const cleaned = JSON.parse(execFileSync(process.execPath, [cliScript, '--config', cfgPath, '--clean', '--all', '--confirm', '--json'], { encoding: 'utf8' }));
  assert.equal(cleaned.removedCount, 2);
  assert.equal(archive.listPlans().length, 0);
  assert.deepEqual(fs.readdirSync(snapshotRoot), [], 'explicit cleanup also removes matched immutable history');
});
