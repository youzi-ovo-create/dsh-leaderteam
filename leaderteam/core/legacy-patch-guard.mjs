// Detects and cleans legacy V2.1 `install-desktop.ps1` profile patches (`cordis.patch.yml`)
// so upgrading to `dsh-leaderteam@2.2.0` (`dsh.bundle`) never silently runs stale V2.1 gate/governance code.
import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_PATCH_BEGIN = '# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)';
export const LEGACY_PATCH_END = '# <<< leaderteam';

/** Inspect a single `cordis.patch.yml` text for legacy V2.1 LeaderTeam overrides. Pure. */
export function inspectPatchTextForLegacyLeaderTeam(patchText, currentBundleRoot = null) {
  if (typeof patchText !== 'string' || !patchText.trim()) {
    return { hasManagedBlock: false, corruptedBlock: false, hasExternalCoreOverride: false };
  }
  const beginIdx = patchText.indexOf(LEGACY_PATCH_BEGIN);
  const endIdx = beginIdx >= 0 ? patchText.indexOf(LEGACY_PATCH_END, beginIdx + LEGACY_PATCH_BEGIN.length) : -1;
  const hasManagedBlock = beginIdx >= 0 && endIdx > beginIdx;
  const corruptedBlock = beginIdx >= 0 && endIdx < 0;

  // Also detect manual/unmarked file-path rows overriding `entry-core.mjs` / `entry-native-executor.mjs` / `entry-lead.mjs`
  // Supports quoted paths containing spaces (e.g. "/home/dev/workspace/Leader Team/...") and both POSIX `file:///home/...`
  // and Windows `file:///C:/...` URLs without stripping the POSIX leading `/`.
  const entryRegex = /(?:(["'`])([^"'`\r\n]*?leaderteam\/(?:entry-core|entry-native-executor|entry-lead)\.mjs)\1|([^\s"'`]+leaderteam\/(?:entry-core|entry-native-executor|entry-lead)\.mjs))/g;
  let hasExternalCoreOverride = false;
  const normRoot = currentBundleRoot
    ? path.posix.normalize(currentBundleRoot.replaceAll('\\', '/')).replace(/\/+$/, '').toLowerCase()
    : null;
  for (const m of patchText.matchAll(entryRegex)) {
    let rawRef = (m[2] ?? m[3] ?? '').replaceAll('\\', '/');
    if (/^file:\/\//i.test(rawRef)) {
      // `file:///C:/foo` -> `C:/foo`, whereas POSIX `file:///home/foo` MUST preserve leading `/home/foo`
      rawRef = /^file:\/\/\/[A-Za-z]:\//i.test(rawRef)
        ? rawRef.replace(/^file:\/\/\//i, '')
        : rawRef.replace(/^file:\/\//i, '');
    }
    const decodedRef = (() => { try { return decodeURIComponent(rawRef); } catch { return rawRef; } })();
    const normRef = path.posix.normalize(decodedRef.replaceAll('\\', '/')).toLowerCase();
    const isInsideCurrentBundle = Boolean(
      normRoot && (normRef === normRoot || normRef.startsWith(`${normRoot}/`)),
    );
    if (!isInsideCurrentBundle) {
      hasExternalCoreOverride = true;
      break;
    }
  }
  return { hasManagedBlock, corruptedBlock, hasExternalCoreOverride };
}

/** Remove the V2.1 managed `# >>> leaderteam ... # <<< leaderteam` block from `cordis.patch.yml` text. Pure. */
export function stripLegacyManagedPatchBlock(patchText) {
  if (typeof patchText !== 'string' || !patchText) {
    return { changed: false, text: '' };
  }
  const beginIdx = patchText.indexOf(LEGACY_PATCH_BEGIN);
  if (beginIdx < 0) return { changed: false, text: patchText };
  const endIdx = patchText.indexOf(LEGACY_PATCH_END, beginIdx + LEGACY_PATCH_BEGIN.length);
  if (endIdx < 0) {
    throw new Error('Corrupted LeaderTeam marker block in cordis.patch.yml (missing "# <<< leaderteam" end marker).');
  }
  const before = patchText.slice(0, beginIdx).trimEnd();
  const after = patchText.slice(endIdx + LEGACY_PATCH_END.length).replace(/^[\r\n]+/, '').trimEnd();
  const joined = [before, after].filter(Boolean).join('\n');
  return {
    changed: true,
    text: joined ? `${joined}\n` : '',
  };
}

/** Scan `<dshHome>/profiles/*` and `<dshHome>/cordis.patch.yml` for legacy V2.1 patch overrides. */
export function detectLegacyProfilePatchConflicts({
  dshHome,
  currentBundleRoot = null,
  fsImpl = fs,
} = {}) {
  const conflicts = [];
  if (!dshHome || typeof dshHome !== 'string') return conflicts;

  const inspectFile = (patchFile, profileName, bundleInstalled) => {
    if (!fsImpl.existsSync(patchFile)) return;
    let content = '';
    try { content = fsImpl.readFileSync(patchFile, 'utf8'); } catch { return; }
    const res = inspectPatchTextForLegacyLeaderTeam(content, currentBundleRoot);
    if (res.hasManagedBlock || res.corruptedBlock || (bundleInstalled && res.hasExternalCoreOverride)) {
      conflicts.push({
        profile: profileName,
        patchFile,
        bundleInstalled,
        hasManagedBlock: res.hasManagedBlock,
        corruptedBlock: res.corruptedBlock,
        hasExternalCoreOverride: res.hasExternalCoreOverride,
      });
    }
  };

  const profilesDir = path.join(dshHome, 'profiles');
  try {
    if (fsImpl.existsSync(profilesDir)) {
      for (const ent of fsImpl.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const pDir = path.join(profilesDir, ent.name);
        let bundleInstalled = false;
        const pkgFile = path.join(pDir, 'package.json');
        if (fsImpl.existsSync(pkgFile)) {
          try {
            const pkg = JSON.parse(fsImpl.readFileSync(pkgFile, 'utf8'));
            const bundles = pkg?.dsh?.profile?.bundles ?? [];
            bundleInstalled = Array.isArray(bundles) && bundles.includes('dsh-leaderteam');
          } catch {}
        }
        inspectFile(path.join(pDir, 'cordis.patch.yml'), ent.name, bundleInstalled);
      }
    }
  } catch {}

  inspectFile(path.join(dshHome, 'cordis.patch.yml'), 'home', false);
  return conflicts;
}

/** Atomically backup and strip legacy V2.1 `# >>> leaderteam ... # <<< leaderteam` blocks under `dshHome`. */
export function cleanLegacyProfilePatches({ dshHome, fsImpl = fs } = {}) {
  const conflicts = detectLegacyProfilePatchConflicts({ dshHome, fsImpl });
  const cleaned = [];
  for (const item of conflicts) {
    if (!item.hasManagedBlock) continue;
    const raw = fsImpl.readFileSync(item.patchFile, 'utf8');
    const stripped = stripLegacyManagedPatchBlock(raw);
    if (!stripped.changed) continue;
    const backupFile = `${item.patchFile}.v21-backup-${Date.now()}`;
    fsImpl.writeFileSync(backupFile, raw, 'utf8');
    const tmpFile = `${item.patchFile}.tmp-${process.pid}-${Date.now()}`;
    fsImpl.writeFileSync(tmpFile, stripped.text, 'utf8');
    fsImpl.renameSync(tmpFile, item.patchFile);
    cleaned.push({ profile: item.profile, patchFile: item.patchFile, backupFile });
  }
  return cleaned;
}
