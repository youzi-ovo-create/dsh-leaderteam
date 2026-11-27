#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Release Governance & Open-Source Hygiene CI Gate (`scripts/ci/verify-release-governance.mjs`)
 *
 * Verifies:
 *   1. Zero broken relative Markdown links across the entire repository.
 *   2. Syntax validity (`node --check`) for all CLI, installer, acceptance, and CI scripts.
 *   3. Open-source purity (zero `.node` native binaries, zero personal path or live secret leaks).
 *   4. Multi-package `version` & `Apache-2.0` license parity (`package.json`, `leaderteam/package.json`, `packages/lt-web/package.json`).
 *   5. Platform tag format & semver consistency when running on a Git tag (`linux-vX.Y.Z`, `windows-vX.Y.Z`, `vX.Y.Z`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'web-dist', 'dist', 'work', 'test-work', 'test-tmp']);
const REDACTION_FIXTURE_ALLOWLIST = new Set([
  'test/unit/v22-dx-doctor-bugreport.test.mjs',
  'scripts/ci/verify-release-governance.mjs',
]);

function walkFiles(dir, onFile) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, onFile);
    else if (ent.isFile()) onFile(full, path.relative(REPO_ROOT, full).replaceAll('\\', '/'));
  }
}

function checkMarkdownLinks() {
  const errors = [];
  let checkedFiles = 0;
  let checkedLinks = 0;

  walkFiles(REPO_ROOT, (full, rel) => {
    if (!rel.endsWith('.md')) return;
    checkedFiles += 1;
    const text = fs.readFileSync(full, 'utf8');
    const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1].trim().split(/\s+/)[0];
      if (/^(https?:|mailto:|#|file:)/i.test(target)) continue;
      const clean = target.split('#')[0].split('?')[0];
      if (!clean) continue;
      checkedLinks += 1;
      let decoded = clean;
      try { decoded = decodeURIComponent(clean); } catch {}
      const resolved = path.resolve(path.dirname(full), decoded);
      if (!fs.existsSync(resolved)) {
        errors.push(`Broken markdown link in ${rel}: (${target})`);
      }
    }
  });

  return { ok: errors.length === 0, checkedFiles, checkedLinks, errors };
}

function checkScriptSyntax() {
  const errors = [];
  const targets = [];
  for (const sub of ['bin', 'installer', 'scripts/acceptance', 'scripts/ci']) {
    walkFiles(path.join(REPO_ROOT, sub), (full, rel) => {
      if (rel.endsWith('.mjs') || rel.endsWith('.cjs') || rel.endsWith('.js')) {
        targets.push({ full, rel });
      }
    });
  }
  for (const t of targets) {
    const res = spawnSync(process.execPath, ['--check', t.full], { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0) {
      errors.push(`Syntax check failed for ${t.rel}: ${String(res.stderr || res.stdout || '').trim()}`);
    }
  }
  return { ok: errors.length === 0, checkedScripts: targets.length, errors };
}

function checkOpenSourceHygiene() {
  const errors = [];
  const leakPatterns = [
    { name: 'personal-home-path', re: /[A-Za-z]:\\Users\\wuyou|\/home\/wuyou/i },
    { name: 'personal-workspace-path', re: /统一工作区/ },
    { name: 'github-live-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { name: 'google-live-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  ];
  const textExts = new Set(['.md', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.json', '.yml', '.yaml', '.sh', '.cmd', '.ps1', '.py']);

  walkFiles(REPO_ROOT, (full, rel) => {
    if (rel.endsWith('.node')) {
      errors.push(`Forbidden native binary in open-source repository: ${rel}`);
      return;
    }
    if (REDACTION_FIXTURE_ALLOWLIST.has(rel)) return;
    if (!textExts.has(path.extname(rel).toLowerCase())) return;
    const text = fs.readFileSync(full, 'utf8');
    for (const pat of leakPatterns) {
      if (pat.re.test(text)) {
        errors.push(`Hygiene leak (${pat.name}) detected in ${rel}`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

function checkPackageVersionParity() {
  const errors = [];
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const innerPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'leaderteam', 'package.json'), 'utf8'));
  const webPkgPath = path.join(REPO_ROOT, 'packages', 'lt-web', 'package.json');
  const webPkg = fs.existsSync(webPkgPath) ? JSON.parse(fs.readFileSync(webPkgPath, 'utf8')) : null;

  if (rootPkg.license !== 'Apache-2.0') {
    errors.push(`Root package.json license must be Apache-2.0, got ${rootPkg.license}`);
  }
  if (innerPkg.version !== rootPkg.version) {
    errors.push(`leaderteam/package.json version (${innerPkg.version}) != root package.json (${rootPkg.version})`);
  }
  if (webPkg && webPkg.version !== rootPkg.version) {
    errors.push(`packages/lt-web/package.json version (${webPkg.version}) != root package.json (${rootPkg.version})`);
  }
  return { ok: errors.length === 0, version: rootPkg.version, errors };
}

function checkTagContract(refArg, pkgVersion) {
  const errors = [];
  const ref = String(refArg || process.env.GITHUB_REF || '').trim();
  if (!ref.startsWith('refs/tags/')) {
    return { ok: true, skipped: true, ref: ref || null, errors };
  }
  const tagName = ref.slice('refs/tags/'.length);
  const m = /^(linux-v|windows-v|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tagName);
  if (!m) {
    errors.push(`Unsupported release tag format "${tagName}". Expected linux-vX.Y.Z, windows-vX.Y.Z, or vX.Y.Z.`);
  } else {
    const tagSemver = m[2].split('-')[0];
    if (tagSemver !== pkgVersion) {
      errors.push(`Release tag "${tagName}" semver (${tagSemver}) does not match package.json version (${pkgVersion}).`);
    }
  }
  return { ok: errors.length === 0, skipped: false, tagName, errors };
}

const refFlagIdx = process.argv.indexOf('--ref');
const refArg = refFlagIdx >= 0 ? process.argv[refFlagIdx + 1] : '';

const links = checkMarkdownLinks();
const syntax = checkScriptSyntax();
const hygiene = checkOpenSourceHygiene();
const pkgParity = checkPackageVersionParity();
const tagCheck = checkTagContract(refArg, pkgParity.version);

const allErrors = [
  ...links.errors,
  ...syntax.errors,
  ...hygiene.errors,
  ...pkgParity.errors,
  ...tagCheck.errors,
];

const summary = {
  ok: allErrors.length === 0,
  version: pkgParity.version,
  markdownLinks: { ok: links.ok, checkedFiles: links.checkedFiles, checkedLinks: links.checkedLinks },
  scriptSyntax: { ok: syntax.ok, checkedScripts: syntax.checkedScripts },
  openSourceHygiene: { ok: hygiene.ok },
  packageVersionParity: { ok: pkgParity.ok },
  tagContract: { ok: tagCheck.ok, skipped: tagCheck.skipped, tagName: tagCheck.tagName ?? null },
  errors: allErrors,
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) {
  process.exit(1);
}
