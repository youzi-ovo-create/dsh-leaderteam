// DSH Host Compatibility Matrix, SemVer range evaluator, and decoupled structural pipeline contract verifier.
// Pure Node.js ESM, zero external dependencies, Apache-2.0.

export const VERIFIED_CORE_VERSIONS = Object.freeze([
  '0.2.2-alpha.2',
  '0.2.2-alpha.3',
  '0.2.2-rc.1',
  '0.2.2-rc.2',
  '0.2.2-rc.3',
  '0.2.2-rc.4',
  '0.2.2-rc.5',
  '0.2.3-alpha.1',
  '0.2.3-alpha.2',
]);

export const SUPPORTED_DSH_ENGINE_RANGE = '>=0.2.2-alpha.2 <1.0.0';

export const CANONICAL_PIPELINE_SNIPPETS = Object.freeze([
  'this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet)',
  'await tool.execute(exec.arguments, exec)',
]);

export const HOST_COMPATIBILITY_MATRIX = Object.freeze([
  Object.freeze({
    series: '0.2.2-rc.5（当前官方 latest / next）',
    versionPattern: '0.2.2-rc.5',
    surfaces: ['CLI', 'dsh web', 'dsh headless'],
    platforms: ['Linux x86_64', 'WSL2', 'Windows x64'],
    status: 'VERIFIED',
    statusLabel: '已端到端实机验真',
    productionAllowed: true,
    safetyGate: 'full',
    notes: '推荐生产环境 CLI / Web 宿主版本；完整通过单测、契约与真实宿主集成套件。',
  }),
  Object.freeze({
    series: '0.2.2-rc.1（官方桌面端首发基线）',
    versionPattern: '0.2.2-rc.1',
    surfaces: ['Official Desktop', 'CLI', 'dsh web', 'dsh headless'],
    platforms: ['Windows x64', 'Linux x86_64', 'WSL2'],
    status: 'VERIFIED',
    statusLabel: '已端到端实机验真',
    productionAllowed: true,
    safetyGate: 'full',
    notes: '官方 Windows Desktop 桌面安装包与 CLI 双端实机验真基线。',
  }),
  Object.freeze({
    series: '0.2.2-rc.2 / 0.2.2-rc.3 / 0.2.2-rc.4',
    versionPattern: '0.2.2-rc.2 ~ 0.2.2-rc.4',
    surfaces: ['Official Desktop', 'CLI', 'dsh web', 'dsh headless'],
    platforms: ['Windows x64', 'Linux x86_64', 'WSL2'],
    status: 'VERIFIED',
    statusLabel: '已核验放行',
    productionAllowed: true,
    safetyGate: 'full',
    notes: '0.2.2 RC 演进序列，ToolExecutionPipeline、ToolsService 与会话协议与 rc.1/rc.5 完全一致。',
  }),
  Object.freeze({
    series: '0.2.2-alpha.2 / 0.2.2-alpha.3',
    versionPattern: '0.2.2-alpha.2 ~ 0.2.2-alpha.3',
    surfaces: ['CLI', 'dsh web', 'dsh headless'],
    platforms: ['Linux x86_64', 'WSL2', 'Windows x64'],
    status: 'VERIFIED',
    statusLabel: '已核验放行（最低支持起点）',
    productionAllowed: true,
    safetyGate: 'full',
    notes: '首次引入 ToolExecutionPipeline 安全门挂载点的最低支持版本。',
  }),
  Object.freeze({
    series: '0.2.3-alpha.1 / 0.2.3-alpha.2（最新预览通道）',
    versionPattern: '0.2.3-alpha.1 ~ 0.2.3-alpha.2',
    surfaces: ['Official Desktop', 'CLI', 'dsh web', 'dsh headless'],
    platforms: ['Linux x86_64', 'WSL2', 'Windows x64'],
    status: 'VERIFIED',
    statusLabel: '已端到端实机验真',
    productionAllowed: true,
    safetyGate: 'full',
    notes: '官方 0.2.3 alpha 通道已实机完成插件安装、安全门拦截与 lt-doctor 全项复验。',
  }),
  Object.freeze({
    series: '0.2.2 正式版 / 0.2.3+ / 0.3.x 后续更新（< 1.0.0）',
    versionPattern: '>=0.2.2 <1.0.0（未来小版本/补丁更新）',
    surfaces: ['Official Desktop', 'CLI', 'dsh web', 'dsh headless'],
    platforms: ['Windows x64', 'Linux x86_64', 'WSL2'],
    status: 'CONTRACT_COMPATIBLE',
    statusLabel: '结构契约自适应兼容（免升级直跑）',
    productionAllowed: true,
    safetyGate: 'full-contract-verified',
    notes: '解除硬编码版本号强绑定：启动时自动校验 ToolExecutionPipeline 与 ToolsService 结构契约，契约未变即可平滑运行；若未来宿主破坏安全门契约则自动 Fail-Closed 拦截。',
  }),
  Object.freeze({
    series: '<= 0.2.1-rc.5 / 0.2.0.x / 旧版 0.13.x',
    versionPattern: '< 0.2.2-alpha.2',
    surfaces: ['Legacy Desktop', 'Legacy CLI'],
    platforms: ['All'],
    status: 'UNSUPPORTED',
    statusLabel: '不支持（缺少安全门管道）',
    productionAllowed: false,
    safetyGate: 'missing',
    notes: '0.2.1 及更早版本尚未引入 @deepseek-ai/dsh-tools/pipeline，无法挂载确定性安全门，安装前与启动时均严格拒绝。',
  }),
]);

/**
 * Parse a SemVer 2.0 version string (`v0.2.3-alpha.2+build1`) without external dependencies.
 */
export function parseDshSemver(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease = m[4] ? m[4].split('.') : [];
  return {
    raw: trimmed,
    major,
    minor,
    patch,
    prerelease,
    build: m[5] ? m[5].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(aList, bList) {
  if (aList.length === 0 && bList.length === 0) return 0;
  // Normal release > prerelease (`0.2.2 > 0.2.2-rc.5`)
  if (aList.length === 0) return 1;
  if (bList.length === 0) return -1;
  const len = Math.max(aList.length, bList.length);
  for (let i = 0; i < len; i++) {
    if (i >= aList.length) return -1;
    if (i >= bList.length) return 1;
    const ai = aList[i];
    const bi = bList[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNum && !bNum) {
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

export function compareDshSemver(a, b) {
  const pa = typeof a === 'object' && a !== null ? a : parseDshSemver(a);
  const pb = typeof b === 'object' && b !== null ? b : parseDshSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(pa.prerelease, pb.prerelease);
}

const MIN_SUPPORTED_SEMVER = parseDshSemver('0.2.2-alpha.2');
const MAX_EXCLUSIVE_SEMVER = parseDshSemver('1.0.0-0');

/**
 * Evaluate simple space-separated comparator sets (`>=0.2.2-alpha.2 <1.0.0` or `||` unions)
 * matching `@deepseek-ai/dsh-app-boot` `includePrerelease: true` semantics.
 */
export function satisfiesDshRange(version, range = SUPPORTED_DSH_ENGINE_RANGE) {
  const parsed = parseDshSemver(version);
  if (!parsed || typeof range !== 'string' || !range.trim()) return false;
  const branches = range.split('||').map(s => s.trim()).filter(Boolean);
  if (branches.length === 0) return false;

  return branches.some(branch => {
    const tokens = branch.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    return tokens.every(tok => {
      if (tok === '*') return true;
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(tok);
      if (!m) return false;
      const op = m[1] || '=';
      let targetStr = m[2].trim();
      // In semver with includePrerelease: `<1.0.0` means strictly below `1.0.0-0` unless prerelease specified
      if (op === '<' && !targetStr.includes('-')) {
        targetStr = `${targetStr}-0`;
      }
      const target = parseDshSemver(targetStr);
      if (!target) return false;
      const cmp = compareDshSemver(parsed, target);
      if (cmp === null) return false;
      if (op === '=') return cmp === 0;
      if (op === '>') return cmp > 0;
      if (op === '>=') return cmp >= 0;
      if (op === '<') return cmp < 0;
      if (op === '<=') return cmp <= 0;
      return false;
    });
  });
}

export function isWithinAdaptiveHostRange(version, range = SUPPORTED_DSH_ENGINE_RANGE) {
  if (range && range !== SUPPORTED_DSH_ENGINE_RANGE) {
    return satisfiesDshRange(version, range);
  }
  const parsed = parseDshSemver(version);
  if (!parsed) return false;
  return (
    compareDshSemver(parsed, MIN_SUPPORTED_SEMVER) >= 0 &&
    compareDshSemver(parsed, MAX_EXCLUSIVE_SEMVER) < 0
  );
}

/**
 * Normalize whitespace/comments so minor transpiler formatting changes (`void 0` vs `undefined`,
 * `Boolean(exec.parent)`, line wrapping, trailing commas) do not cause false-negative rejections,
 * while strictly verifying that `dispatchToolBody` resolves execution for `(exec.name, exec.agent, ..., exec.toolSet)`
 * and dispatches `execute(exec.arguments, exec)` in order.
 */
export function evaluateDispatchToolBodyContract(sourceText) {
  const src = String(sourceText ?? '');
  if (!src.trim()) {
    return {
      compatible: false,
      exactCanonicalMatch: false,
      dispatchToolBodyPresent: false,
      resolveExecutionPresent: false,
      toolExecutePresent: false,
      orderedCorrectly: false,
    };
  }

  const exactResolve = src.includes(CANONICAL_PIPELINE_SNIPPETS[0]);
  const exactExecute = src.includes(CANONICAL_PIPELINE_SNIPPETS[1]);
  if (exactResolve && exactExecute) {
    const rIdx = src.indexOf(CANONICAL_PIPELINE_SNIPPETS[0]);
    const eIdx = src.indexOf(CANONICAL_PIPELINE_SNIPPETS[1]);
    const ordered = rIdx >= 0 && eIdx > rIdx;
    return {
      compatible: ordered,
      exactCanonicalMatch: ordered,
      dispatchToolBodyPresent: true,
      resolveExecutionPresent: true,
      toolExecutePresent: true,
      orderedCorrectly: ordered,
    };
  }

  const compact = src.replace(/\s+/g, '');
  // Match parameter name of dispatchToolBody(param) or function(param)
  const paramMatch =
    /(?:dispatchToolBody|function(?:\s*[A-Za-z0-9_$]+)?)\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/.exec(src) ||
    /^\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*=>/.exec(src.trim());
  const p = paramMatch ? paramMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'exec';

  const resolveRe = new RegExp(
    `this\\.resolveExecution\\(${p}\\.name,${p}\\.agent,(?:${p}\\.parent!==(?:void0|void\\(0\\)|undefined)|Boolean\\(${p}\\.parent\\)|!!${p}\\.parent),${p}\\.toolSet(?:,[^)]*)?\\)`,
  );
  const executeRe = new RegExp(
    `await[A-Za-z_$][A-Za-z0-9_$]*\\.execute\\(${p}\\.arguments,${p}(?:,[^)]*)?\\)`,
  );

  const resolveMatch = resolveRe.exec(compact);
  const executeMatch = executeRe.exec(compact);
  const resolveExecutionPresent = Boolean(resolveMatch);
  const toolExecutePresent = Boolean(executeMatch);
  const orderedCorrectly =
    resolveExecutionPresent && toolExecutePresent && resolveMatch.index < executeMatch.index;

  return {
    compatible: orderedCorrectly,
    exactCanonicalMatch: false,
    dispatchToolBodyPresent: compact.length > 0,
    resolveExecutionPresent,
    toolExecutePresent,
    orderedCorrectly,
  };
}

export function evaluateToolsServiceResolveContract(sourceText) {
  const compact = String(sourceText ?? '').replace(/\s+/g, '');
  const hasViewCall = /this\.view\([A-Za-z_$][A-Za-z0-9_$]*\)/.test(compact);
  const hasAdmitted = compact.includes('admitted');
  return {
    compatible: hasViewCall && hasAdmitted,
    hasViewCall,
    hasAdmitted,
  };
}

/**
 * Evaluate full host compatibility status for a given toolsVersion and pipeline source/prototype.
 *
 * Classifications:
 * - `VERIFIED`: In `supportedVersions` AND structural contract holds (`productionAllowed: true`).
 * - `CONTRACT_COMPATIBLE`: Not in `supportedVersions`, `policy === 'adaptive'`, version satisfies
 *   `supportedRange` (`>=0.2.2-alpha.2 <1.0.0`), AND structural contract holds (`productionAllowed: true`).
 * - `UNVERIFIED_COMPATIBLE_SHAPE`: Structural contract holds, but either `policy === 'strict-verified'`
 *   or version is outside `supportedRange` (`productionAllowed: false`).
 * - `INCOMPATIBLE_PIPELINE`: Structural contract broken or missing (`productionAllowed: false`, Fail-Closed).
 */
export function evaluateHostCompatibility({
  toolsVersion,
  desktopVersion = null,
  pipelineSource = '',
  supportedVersions = VERIFIED_CORE_VERSIONS,
  supportedRange = SUPPORTED_DSH_ENGINE_RANGE,
  policy = 'adaptive',
} = {}) {
  const verifiedList = Array.isArray(supportedVersions) && supportedVersions.length > 0
    ? [...supportedVersions]
    : [...VERIFIED_CORE_VERSIONS];
  const effectivePolicy = policy === 'strict-verified' ? 'strict-verified' : 'adaptive';
  const contract = evaluateDispatchToolBodyContract(pipelineSource);
  const versionStr = typeof toolsVersion === 'string' ? toolsVersion.trim() : '';
  const versionVerified = Boolean(versionStr) && verifiedList.includes(versionStr);
  const inAdaptiveRange = Boolean(versionStr) && satisfiesDshRange(versionStr, supportedRange);

  if (!contract.compatible) {
    return {
      status: 'fail',
      classification: 'INCOMPATIBLE_PIPELINE',
      classificationLabel: 'INCOMPATIBLE_PIPELINE',
      policy: effectivePolicy,
      toolsVersion: versionStr || null,
      desktopVersion,
      supportedCoreVersions: verifiedList,
      supportedCoreRange: supportedRange,
      exactCanonicalMatch: false,
      requiredInvariants: {
        dispatchToolBodyPresent: contract.dispatchToolBodyPresent,
        resolveExecutionPresent: contract.resolveExecutionPresent,
        toolExecutePresent: contract.toolExecutePresent,
      },
      productionAllowed: false,
      summary: `@deepseek-ai/dsh-tools ${versionStr || 'unknown'} failed pipeline invariant check (INCOMPATIBLE_PIPELINE — safety gate cannot attach; blocked in production).`,
    };
  }

  if (versionVerified) {
    return {
      status: 'pass',
      classification: 'VERIFIED',
      classificationLabel: 'VERIFIED',
      policy: effectivePolicy,
      toolsVersion: versionStr,
      desktopVersion,
      supportedCoreVersions: verifiedList,
      supportedCoreRange: supportedRange,
      exactCanonicalMatch: contract.exactCanonicalMatch,
      requiredInvariants: {
        dispatchToolBodyPresent: true,
        resolveExecutionPresent: true,
        toolExecutePresent: true,
      },
      productionAllowed: true,
      summary: `@deepseek-ai/dsh-tools ${versionStr} is VERIFIED and matches all dispatchToolBody safety-gate invariants.`,
    };
  }

  if (effectivePolicy === 'adaptive' && inAdaptiveRange) {
    return {
      status: 'pass',
      classification: 'CONTRACT_COMPATIBLE',
      classificationLabel: 'CONTRACT_COMPATIBLE (adaptive structural contract verified)',
      policy: effectivePolicy,
      toolsVersion: versionStr,
      desktopVersion,
      supportedCoreVersions: verifiedList,
      supportedCoreRange: supportedRange,
      exactCanonicalMatch: contract.exactCanonicalMatch,
      requiredInvariants: {
        dispatchToolBodyPresent: true,
        resolveExecutionPresent: true,
        toolExecutePresent: true,
      },
      productionAllowed: true,
      summary: `@deepseek-ai/dsh-tools ${versionStr} satisfies ${supportedRange} and passes structural safety-gate contract verification (CONTRACT_COMPATIBLE — allowed under adaptive host policy).`,
    };
  }

  return {
    status: 'warn',
    classification: 'UNVERIFIED_COMPATIBLE_SHAPE',
    classificationLabel: 'UNVERIFIED_COMPATIBLE_SHAPE (isolated test only — blocked in production)',
    policy: effectivePolicy,
    toolsVersion: versionStr || null,
    desktopVersion,
    supportedCoreVersions: verifiedList,
    supportedCoreRange: supportedRange,
    exactCanonicalMatch: contract.exactCanonicalMatch,
    requiredInvariants: {
      dispatchToolBodyPresent: true,
      resolveExecutionPresent: true,
      toolExecutePresent: true,
    },
    productionAllowed: false,
    summary: `@deepseek-ai/dsh-tools ${versionStr} matches dispatchToolBody invariants -> UNVERIFIED_COMPATIBLE_SHAPE (isolated test only — blocked in production; verified versions: ${verifiedList.join(', ')}).`,
  };
}

export function getHostCompatibilityMatrix({ track = 'open-source', currentHostVersion = null } = {}) {
  const currentEval = currentHostVersion
    ? {
        version: currentHostVersion,
        verified: VERIFIED_CORE_VERSIONS.includes(currentHostVersion),
        inAdaptiveRange: isWithinAdaptiveHostRange(currentHostVersion),
      }
    : null;
  return {
    track,
    engineRange: SUPPORTED_DSH_ENGINE_RANGE,
    minSupportedVersion: '0.2.2-alpha.2',
    recommendedVersions: {
      desktop: '0.2.2-rc.1',
      cliWeb: '0.2.2-rc.5',
      preview: '0.2.3-alpha.2',
    },
    verifiedVersions: [...VERIFIED_CORE_VERSIONS],
    defaultPolicy: 'adaptive',
    currentHost: currentEval,
    rows: HOST_COMPATIBILITY_MATRIX.map(r => ({ ...r, surfaces: [...r.surfaces], platforms: [...r.platforms] })),
  };
}

export function renderCompatibilityMatrixMarkdown({ track = 'open-source' } = {}) {
  const matrix = getHostCompatibilityMatrix({ track });
  const lines = [
    `# DeepSeek Harness (DSH) 宿主版本兼容性列表`,
    '',
    `- **支持范围声明（\`engines.dsh\`）**：\`${matrix.engineRange}\`（含预发布通道 \`alpha\` / \`rc\`）`,
    `- **已实机核验版本清单**：${matrix.verifiedVersions.map(v => `\`${v}\``).join('、')}`,
    `- **默认兼容策略**：\`adaptive\`（自适应结构契约校验——在 \`${matrix.engineRange}\` 范围内，宿主小版本或桌面端更新只要保持 \`ToolExecutionPipeline\` 与 \`ToolsService\` 安全门挂载契约不变即可直接运行，无需等待 LT 重新发版；若宿主未来改动破坏安全门契约则自动 **Fail-Closed** 阻断保护）`,
    '',
    '| DSH 版本系列 | 适用形态 | 支持平台 | 兼容等级 | 生产可用 | 说明 |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of matrix.rows) {
    const badge =
      row.status === 'VERIFIED'
        ? '已实机认证 (`VERIFIED`)'
        : row.status === 'CONTRACT_COMPATIBLE'
          ? '契约自适应兼容 (`CONTRACT_COMPATIBLE`)'
          : '不支持 (`UNSUPPORTED`)';
    lines.push(
      `| \`${row.versionPattern}\`<br>${row.series} | ${row.surfaces.join(' / ')} | ${row.platforms.join(', ')} | ${badge} | ${row.productionAllowed ? '是' : '否'} | ${row.notes} |`,
    );
  }
  lines.push(
    '',
    '## 安装前离线自检命令',
    '',
    '```bash',
    '# 查看完整兼容性列表',
    'node bin/lt-doctor.mjs --compatibility-matrix',
    '',
    '# 自动检测本机已安装的 DSH 客户端 / CLI 版本与安全门兼容性',
    'node bin/lt-doctor.mjs',
    '',
    '# 指定自定义 DSH 安装目录预检（支持 Windows Desktop 目录、app.asar 或 npm/pnpm 目录）',
    'node bin/lt-doctor.mjs --check-host "<DSH安装目录>"',
    '```',
  );
  return lines.join('\n');
}
