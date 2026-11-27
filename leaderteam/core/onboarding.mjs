// First-run Onboarding Wizard state, quick provider key provisioning, team collaboration presets,
// and starter task templates for non-technical & developer users.
// Pure Node.js ESM, zero external dependencies, Apache-2.0.

import fs from 'node:fs';
import path from 'node:path';
import { SOLO_PROVIDER_PRESETS, buildSoloKeyStarterConfig, buildSoloProviderSettingsTemplates } from './solo-key.mjs';
import { writeFileAtomic } from './store.mjs';
import { loadConfig } from './config.mjs';
import { applyModelConfigChanges } from './model-config-writer.mjs';
import {
  parseUpstreamModelsPayload,
  inferModelFamily,
  inferEffortsFromMetadata,
  resolveModelTarget,
  syncUpstreamModelsToDshSettings,
} from './upstream-models.mjs';

export const ONBOARDING_STATE_FILENAME = 'onboarding.json';

export const QUICK_PROVIDER_PRESETS = Object.freeze(
  SOLO_PROVIDER_PRESETS.map(p =>
    Object.freeze({
      id: p.id,
      provider: p.provider,
      displayName: p.displayName,
      envVar: p.envVars[0],
      defaultBaseURL: p.defaultBaseURL,
      reasoningRoute: p.reasoningRoute,
      reasoningLabel: p.reasoningLabel,
      chatRoute: p.chatRoute,
      chatLabel: p.chatLabel,
      keyPlaceholder:
        p.id === 'deepseek'
          ? 'sk-...'
          : p.id === 'dashscope'
            ? 'sk-...'
            : p.id === 'zhipu'
              ? '填写智谱开放平台 API Key'
              : 'sk-proj-...',
      guideHint:
        p.id === 'deepseek'
          ? '前往 platform.deepseek.com 创建 API Key，粘贴即可零配置启动全部角色。'
          : p.id === 'dashscope'
            ? '前往阿里云百炼控制台获取 DASHSCOPE_API_KEY，自动配置 Qwen Max 与 Qwen Plus。'
            : p.id === 'zhipu'
              ? '前往 bigmodel.cn 获取 API Key，自动配置 GLM-4.5 与 GLM-4.5 Air。'
              : '前往 platform.openai.com 获取 API Key，自动配置 GPT-4.1 与 GPT-4.1 Mini。',
    }),
  ),
);

export const TEAM_COLLAB_PRESETS = Object.freeze([
  Object.freeze({
    id: 'balanced-team',
    label: '标准自治团队（推荐）',
    defaultSessionMode: 'team',
    maxActiveMembers: 4,
    summary: '领队自动拆解任务并分派执行成员，后台双席评审与安全门自动防跑偏，适合大多数完整需求开发与问题修复。',
  }),
  Object.freeze({
    id: 'lightweight-team',
    label: '轻量精简团队（快速上手）',
    defaultSessionMode: 'team',
    maxActiveMembers: 2,
    summary: '控制并行成员上限（最多 2 名成员），兼顾快速响应与安全门、双席评审守护，适合小范围修改、代码梳理与快速验证。',
  }),
  Object.freeze({
    id: 'strict-team',
    label: '高并发深审团队（大型工程）',
    defaultSessionMode: 'team',
    maxActiveMembers: 6,
    summary: '提高并行成员上限，保持完整规划共识、双席异步监督、独立裁断与外部归档，适合跨模块重构与长周期项目。',
  }),
]);

export const STARTER_TASK_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'project-tour',
    title: '梳理项目结构并生成导览说明',
    recommendedMode: 'team',
    description: '只读扫描当前工作区目录与关键文件，用通俗易懂的语言总结项目结构、运行方式与核心模块职责。',
    prompt: '请先只读浏览当前工作区的目录结构和主要说明文件，用清晰简明的中文为我生成一份项目结构导览、核心功能说明以及本地运行步骤（暂不修改任何源码文件）。',
  }),
  Object.freeze({
    id: 'code-health-check',
    title: '团队协作排查潜在问题并给出改进方案',
    recommendedMode: 'team',
    description: '体验 LT 多角色自治协作：由领队规划检查范围、成员分头核查代码边界与测试覆盖，经评审把关后输出可执行报告。',
    prompt: '请组织团队对当前工作区代码进行一次结构化的质量与边界隐患巡检，梳理最值得优先处理的 3 个问题，并给出具体的修复建议与验证方法。',
  }),
  Object.freeze({
    id: 'first-feature-task',
    title: '动手完成第一个小型优化或测试补充',
    recommendedMode: 'team',
    description: '完整走通“规划 → 安全门守护修改 → 双席监督 → 测试验收”闭环。',
    prompt: '请检查当前工作区现有的测试或示例脚本，挑选一处缺失的边界场景补充自动化测试并运行验证，确保不破坏任何现有功能。',
  }),
]);

function maskKeyPreview(rawKey) {
  const s = String(rawKey ?? '').trim();
  if (!s) return null;
  if (s.length <= 8) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export function resolveOnboardingFilePath(storageRoot) {
  if (!storageRoot) return null;
  return path.join(storageRoot, ONBOARDING_STATE_FILENAME);
}

export function readPersistedOnboardingRecord(storageRoot, fsImpl = fs) {
  const defaults = {
    version: 1,
    completed: false,
    dismissed: false,
    completedAt: null,
    dismissedAt: null,
    selectedProviderId: null,
    keyPreview: null,
    selectedCollabPreset: 'balanced-team',
    defaultSessionMode: 'team',
    firstSessionId: null,
    updatedAt: null,
  };
  const filePath = resolveOnboardingFilePath(storageRoot);
  if (!filePath || !fsImpl.existsSync(filePath)) return defaults;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaults;
    return {
      version: 1,
      completed: Boolean(raw.completed),
      dismissed: Boolean(raw.dismissed),
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
      dismissedAt: typeof raw.dismissedAt === 'string' ? raw.dismissedAt : null,
      selectedProviderId: typeof raw.selectedProviderId === 'string' ? raw.selectedProviderId : null,
      keyPreview: typeof raw.keyPreview === 'string' ? raw.keyPreview : null,
      selectedCollabPreset:
        TEAM_COLLAB_PRESETS.some(p => p.id === raw.selectedCollabPreset) ? raw.selectedCollabPreset : 'balanced-team',
      defaultSessionMode: 'team',
      firstSessionId: typeof raw.firstSessionId === 'string' ? raw.firstSessionId : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch {
    return defaults;
  }
}

export function writePersistedOnboardingRecord(storageRoot, patch = {}) {
  const filePath = resolveOnboardingFilePath(storageRoot);
  if (!filePath) throw new Error('storageRoot is required to persist onboarding state');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prev = readPersistedOnboardingRecord(storageRoot);
  const nowIso = new Date().toISOString();
  const next = {
    ...prev,
    ...patch,
    version: 1,
    updatedAt: nowIso,
  };
  // Never persist raw API keys under any field
  delete next.apiKey;
  delete next.rawKey;
  delete next.secret;
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function upsertCredentialRefInYamlFile(credFile, envVarName, secretValue, fsImpl = fs) {
  let raw = '';
  try {
    if (fsImpl.existsSync(credFile)) raw = fsImpl.readFileSync(credFile, 'utf8');
  } catch {}
  const normalized = raw ? raw.replace(/\r\n/g, '\n') : '';
  const quoted = JSON.stringify(secretValue);
  if (!normalized.trim()) {
    const fresh = `version: 1\nrefs:\n  ${envVarName}: ${quoted}\n`;
    writeFileAtomic(credFile, fresh);
    if (process.platform !== 'win32') {
      try { fsImpl.chmodSync(credFile, 0o600); } catch {}
    }
    return;
  }

  let lines = normalized.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const hasVersion1 = lines.some(l => /^version\s*:\s*1\b/.test(l));
  if (!hasVersion1) {
    lines = ['version: 1', 'refs:', ...lines.map(l => (l.trim() ? `  ${l.trimStart()}` : l))];
  }

  let refsIdx = lines.findIndex(l => /^refs\s*:\s*(?:#.*)?$/.test(l));
  if (refsIdx < 0) {
    const emptyRefsIdx = lines.findIndex(l => /^refs\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(l));
    if (emptyRefsIdx >= 0) {
      lines[emptyRefsIdx] = 'refs:';
      refsIdx = emptyRefsIdx;
    } else {
      lines.push('refs:');
      refsIdx = lines.length - 1;
    }
  }

  // Locate existing key inside `refs:` block
  const keyRe = new RegExp(`^\\s{2,}["']?${envVarName}["']?\\s*:`);
  let replaced = false;
  for (let i = refsIdx + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_"']/.test(lines[i])) break; // entered next top-level section (e.g. `records:`)
    if (keyRe.test(lines[i])) {
      lines[i] = `  ${envVarName}: ${quoted}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.splice(refsIdx + 1, 0, `  ${envVarName}: ${quoted}`);
  }
  writeFileAtomic(credFile, `${lines.join('\n')}\n`);
  if (process.platform !== 'win32') {
    try { fsImpl.chmodSync(credFile, 0o600); } catch {}
  }
}

/**
 * Persist an environment credential into `$DSH_HOME/.credentials.yaml` (`version: 1` `refs:`, live-watched by DSH!),
 * `$DSH_HOME/.env` (mode 0600 on POSIX), AND live `ctx.credentials` when mounted.
 */
export async function persistProviderApiKey({
  ctx = null,
  dshHome = null,
  envVarName,
  apiKey,
  env = process.env,
  fsImpl = fs,
} = {}) {
  const cleanVar = String(envVarName ?? '').trim();
  const cleanKey = String(apiKey ?? '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(cleanVar)) {
    throw new Error(`非法的凭据环境变量名：${cleanVar}`);
  }
  if (!cleanKey || /[\r\n\0]/.test(cleanKey)) {
    throw new Error('API Key 不能为空且不能包含换行或控制字符');
  }

  let storedInHostCredentials = false;
  let storedInDshCredentialsYaml = false;
  let storedInDshEnvFile = false;

  // 1. Live DSH credential service (`ctx.credentials.set`) — takes effect immediately on next LLM call
  const credSvc =
    (typeof ctx?.get === 'function' ? ctx.get('credentials') : null) ??
    ctx?.credentials ??
    (typeof ctx?.root?.get === 'function' ? ctx.root.get('credentials') : null) ??
    null;
  if (credSvc && typeof credSvc.set === 'function') {
    try {
      await credSvc.set(cleanVar, cleanKey);
      storedInHostCredentials = true;
    } catch {
      // Fallback to .credentials.yaml / .env below if host credential store rejects or is read-only
    }
  }

  // 2. Write/update `$DSH_HOME/.credentials.yaml` (live-watched via chokidar in `@deepseek-ai/dsh-credentials-local`!)
  //    AND `$DSH_HOME/.env` so both live running DSH Desktop/Web and standalone restarts resolve the key immediately!
  if (dshHome) {
    fsImpl.mkdirSync(dshHome, { recursive: true });
    const credYamlPath = path.join(dshHome, '.credentials.yaml');
    let hostAlreadyWroteDisk = false;
    if (storedInHostCredentials && fsImpl.existsSync(credYamlPath)) {
      try {
        hostAlreadyWroteDisk = fsImpl.readFileSync(credYamlPath, 'utf8').includes(cleanVar);
      } catch {}
    }
    if (!hostAlreadyWroteDisk) {
      try {
        upsertCredentialRefInYamlFile(credYamlPath, cleanVar, cleanKey, fsImpl);
        storedInDshCredentialsYaml = true;
      } catch {}
    } else {
      storedInDshCredentialsYaml = true;
    }
    const envFile = path.join(dshHome, '.env');
    let existingLines = [];
    if (fsImpl.existsSync(envFile)) {
      try {
        existingLines = fsImpl.readFileSync(envFile, 'utf8').split(/\r?\n/);
      } catch {
        existingLines = [];
      }
    }
    const escapedVal = JSON.stringify(cleanKey);
    const targetPrefix = `${cleanVar}=`;
    let replaced = false;
    const nextLines = existingLines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith(targetPrefix) || trimmed.startsWith(`export ${targetPrefix}`)) {
        replaced = true;
        return `${cleanVar}=${escapedVal}`;
      }
      return line;
    });
    if (!replaced) {
      if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
        nextLines.splice(nextLines.length - 1, 0, `${cleanVar}=${escapedVal}`);
      } else {
        nextLines.push(`${cleanVar}=${escapedVal}`);
      }
    }
    const content = `${nextLines.filter((l, idx, arr) => !(idx === arr.length - 1 && l === '')).join('\n')}\n`;
    writeFileAtomic(envFile, content);
    if (process.platform !== 'win32') {
      try { fsImpl.chmodSync(envFile, 0o600); } catch {}
    }
    storedInDshEnvFile = true;
  }

  // 3. Keep current process env in sync for immediate Solo-Key template discovery
  if (env && typeof env === 'object') {
    env[cleanVar] = cleanKey;
  }

  return {
    envVarName: cleanVar,
    maskedPreview: maskKeyPreview(cleanKey),
    storedInHostCredentials,
    storedInDshCredentialsYaml,
    storedInDshEnvFile,
  };
}

/**
 * Optional lightweight connectivity check against an OpenAI-compatible `/models` endpoint
 * with friendly Chinese diagnostics for beginners.
 */
export async function probeProviderKeyConnectivity({
  baseURL,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: true, skipped: true, message: '当前环境不支持在线连通性预检，已跳过验证直接保存。' };
  }
  const cleanBase = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!cleanBase) {
    return { ok: false, code: 'INVALID_BASE_URL', message: '接口地址（Base URL）不能为空。' };
  }
  const modelsUrl = cleanBase.endsWith('/v1') || cleanBase.endsWith('/v4')
    ? `${cleanBase}/models`
    : `${cleanBase}/v1/models`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${String(apiKey || '').trim()}`,
        Accept: 'application/json',
      },
      signal: ac.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: 'AUTH_FAILED',
        status: res.status,
        message: 'API Key 验证未通过（HTTP ' + res.status + '）：请检查是否完整复制了有效的密钥，且没有多余空格。',
      };
    }
    if (res.status === 402) {
      return {
        ok: false,
        code: 'INSUFFICIENT_BALANCE',
        status: 402,
        message: '该 API Key 账户余额或免费额度不足（HTTP 402），请前往厂商控制台充值或检查额度。',
      };
    }
    if (!res.ok && res.status >= 500) {
      return {
        ok: false,
        code: 'UPSTREAM_ERROR',
        status: res.status,
        message: `上游模型服务暂时繁忙（HTTP ${res.status}），您可以稍后重试或直接保存配置。`,
      };
    }
    let discoveredModels = [];
    try {
      const payload = await res.json();
      discoveredModels = parseUpstreamModelsPayload(payload);
    } catch {}
    return {
      ok: true,
      status: res.status,
      models: discoveredModels,
      message: 'API Key 连通性校验通过！',
    };
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return {
      ok: false,
      code: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: isAbort
        ? '连接模型接口超时：请检查本机网络或代理设置，或勾选“跳过连通性测试直接保存”。'
        : `无法连接到模型接口（${cleanBase}）：请检查网络连接或接口地址是否正确。`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function detectConfiguredCredentialPresence({ dshHome = null, env = process.env, fsImpl = fs } = {}) {
  const detectedEnvVars = [];
  for (const preset of SOLO_PROVIDER_PRESETS) {
    for (const v of preset.envVars) {
      if (typeof env?.[v] === 'string' && env[v].trim().length > 0) {
        detectedEnvVars.push(v);
      }
    }
  }
  if (dshHome) {
    for (const rel of ['.credentials.yaml', '.env']) {
      const f = path.join(dshHome, rel);
      if (!fsImpl.existsSync(f)) continue;
      try {
        const txt = fsImpl.readFileSync(f, 'utf8');
        for (const preset of SOLO_PROVIDER_PRESETS) {
          for (const v of preset.envVars) {
            if (new RegExp(`(?:^|\\s)${v}\\s*[:=]`, 'm').test(txt) && !detectedEnvVars.includes(v)) {
              detectedEnvVars.push(v);
            }
          }
        }
      } catch {}
    }
  }
  return {
    hasAnySoloCredential: detectedEnvVars.length > 0,
    detectedEnvVars,
  };
}

export function buildOnboardingSnapshot({
  storageRoot,
  dshHome = null,
  hasLocalOverrides = false,
  hasGatewayRunning = false,
  hasExternalProviders = false,
  sessionCount = 0,
  defaultWorkspace = process.cwd(),
  env = process.env,
  fsImpl = fs,
} = {}) {
  const persisted = readPersistedOnboardingRecord(storageRoot, fsImpl);
  const credPresence = detectConfiguredCredentialPresence({ dshHome, env, fsImpl });
  const modelReady =
    Boolean(persisted.selectedProviderId) ||
    credPresence.hasAnySoloCredential ||
    Boolean(hasLocalOverrides) ||
    Boolean(hasGatewayRunning) ||
    Boolean(hasExternalProviders);
  const teamReady = Boolean(persisted.completed) || Boolean(hasLocalOverrides) || modelReady;
  const firstTaskCreated = Boolean(persisted.firstSessionId) || Number(sessionCount) > 0;
  const shouldAutoOpen =
    !persisted.completed &&
    !persisted.dismissed &&
    (!modelReady || Number(sessionCount) === 0);

  return {
    ...persisted,
    shouldAutoOpen,
    steps: {
      modelConnected: modelReady,
      teamConfigured: teamReady,
      firstTaskCreated,
    },
    detectedEnvVars: credPresence.detectedEnvVars,
    defaultWorkspace,
    providerPresets: QUICK_PROVIDER_PRESETS,
    collabPresets: TEAM_COLLAB_PRESETS,
    starterTasks: STARTER_TASK_TEMPLATES,
  };
}

/**
 * One-click onboarding apply: stores API Key (optional if already set), writes valid model & role config
 * to `leaderteam.local.json`, syncs routes to DSH `llm-pi-ai` settings, and updates onboarding record.
 */
export async function applyQuickOnboardingSetup({
  ctx = null,
  rt = null,
  storageRoot,
  dshHome = null,
  configPath,
  bundledDefaultConfigPath,
  providerId = 'deepseek',
  apiKey = '',
  customBaseURL = '',
  modelId = '',
  reasoningModel = '',
  chatModel = '',
  discoveredModels = null,
  collabPresetId = 'balanced-team',
  verifyConnectivity = false,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const preset = SOLO_PROVIDER_PRESETS.find(p => p.id === providerId || p.provider === providerId) ?? SOLO_PROVIDER_PRESETS[0];
  const collab = TEAM_COLLAB_PRESETS.find(c => c.id === collabPresetId) ?? TEAM_COLLAB_PRESETS[0];
  const cleanKey = String(apiKey ?? '').trim();
  const effectiveBaseURL = String(customBaseURL ?? '').trim().replace(/\/+$/, '') || preset.defaultBaseURL;

  let probedModels = Array.isArray(discoveredModels)
    ? discoveredModels
        .map(m => (typeof m === 'string' ? { id: m.trim() } : m))
        .filter(m => m && typeof m.id === 'string' && m.id.trim())
    : [];
  if (verifyConnectivity && cleanKey) {
    const probe = await probeProviderKeyConnectivity({
      baseURL: effectiveBaseURL,
      apiKey: cleanKey,
      fetchImpl,
    });
    if (!probe.ok) {
      const err = new Error(probe.message);
      err.code = probe.code || 'CONNECTIVITY_CHECK_FAILED';
      throw err;
    }
    if (Array.isArray(probe.models) && probe.models.length > 0) {
      probedModels = probe.models;
    }
  }
  const explicitReasoningId = String(reasoningModel || modelId || '').trim();
  const explicitChatId = String(chatModel || modelId || '').trim();
  if (explicitReasoningId && !probedModels.some(m => m.id === explicitReasoningId)) {
    probedModels = [{ id: explicitReasoningId, name: explicitReasoningId }, ...probedModels];
  }
  if (explicitChatId && !probedModels.some(m => m.id === explicitChatId)) {
    probedModels = [...probedModels, { id: explicitChatId, name: explicitChatId }];
  }

  let keyResult = null;
  if (cleanKey) {
    keyResult = await persistProviderApiKey({
      ctx,
      dshHome,
      envVarName: preset.envVars[0],
      apiKey: cleanKey,
      env,
    });
  }

  const baseRaw = JSON.parse(fs.readFileSync(bundledDefaultConfigPath, 'utf8'));
  let customizedPreset = effectiveBaseURL !== preset.defaultBaseURL
    ? { ...preset, defaultBaseURL: effectiveBaseURL }
    : { ...preset };

  // When live `/v1/models` returned actual served model IDs and the preset's static reasoning model ID
  // is not served by that endpoint (e.g. standard `api.deepseek.com` serving `deepseek-reasoner` + `deepseek-chat`,
  // or a custom OpenAI-compatible relay), automatically align starter routes to the endpoint's real models!
  const stripPresetProv = r => (r.startsWith(`${preset.provider}/`) ? r.slice(preset.provider.length + 1) : r);
  const presetReasoningId = customizedPreset.reasoningUpstreamModel ?? stripPresetProv(customizedPreset.reasoningRoute);
  if (explicitReasoningId || (probedModels.length > 0 && !probedModels.some(m => m.id === presetReasoningId))) {
    const scoreReasoner = id => {
      if (explicitReasoningId && id === explicitReasoningId) return 100;
      const lower = String(id).toLowerCase();
      let s = 0;
      if (/reasoner|r1|pro|max|opus|gpt-5|gpt-4\.1|o3|o4|glm-5|glm-4\.5|qwq|thinking/.test(lower)) s += 10;
      if (/flash|mini|air|haiku|turbo|lite/.test(lower)) s -= 3;
      return s;
    };
    const sorted = [...probedModels].sort((a, b) => scoreReasoner(b.id) - scoreReasoner(a.id));
    const chosenReasoner = (explicitReasoningId ? probedModels.find(m => m.id === explicitReasoningId) : null) ?? sorted[0];
    const chosenChat =
      (explicitChatId ? probedModels.find(m => m.id === explicitChatId) : null)
      ?? probedModels.find(m => m.id !== chosenReasoner.id && /chat|flash|mini|plus|air|sonnet|v3/i.test(m.id))
      ?? probedModels.find(m => m.id !== chosenReasoner.id)
      ?? chosenReasoner;
    const rInf = inferEffortsFromMetadata({
      family: inferModelFamily(chosenReasoner.id, preset.provider),
      modelId: chosenReasoner.id,
      resolvedInfo: chosenReasoner,
      fromEndpointOnly: true,
    });
    const cInf = inferEffortsFromMetadata({
      family: inferModelFamily(chosenChat.id, preset.provider),
      modelId: chosenChat.id,
      resolvedInfo: chosenChat,
      fromEndpointOnly: true,
    });
    const rEffs = rInf.efforts.includes('none') ? rInf.efforts : ['none', ...rInf.efforts];
    customizedPreset = {
      ...customizedPreset,
      reasoningRoute: `${preset.provider}/${chosenReasoner.id}`,
      reasoningUpstreamModel: chosenReasoner.id,
      reasoningLabel: chosenReasoner.name || chosenReasoner.id,
      reasoningEfforts: rEffs,
      reasoningDefaultEffort:
        preset.reasoningDefaultEffort && rEffs.includes(preset.reasoningDefaultEffort)
          ? preset.reasoningDefaultEffort
          : (rInf.defaultEffort === 'none' && rEffs.includes('high') ? 'high' : rInf.defaultEffort),
      ...(chosenReasoner.contextWindow ? { reasoningContextWindow: chosenReasoner.contextWindow } : {}),
      ...(chosenReasoner.maxTokens ? { reasoningMaxTokens: chosenReasoner.maxTokens } : {}),
      chatRoute: `${preset.provider}/${chosenChat.id}`,
      chatUpstreamModel: chosenChat.id,
      chatLabel: chosenChat.name || chosenChat.id,
      chatEfforts: cInf.efforts,
      chatDefaultEffort: cInf.defaultEffort,
      ...(chosenChat.contextWindow ? { chatContextWindow: chosenChat.contextWindow } : {}),
      ...(chosenChat.maxTokens ? { chatMaxTokens: chosenChat.maxTokens } : {}),
    };
  }

  const starterCfg = buildSoloKeyStarterConfig(baseRaw, { preset: customizedPreset });
  if (configPath && !fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(starterCfg, null, 2)}\n`);
  }

  const upsertModels = Object.entries(starterCfg.models).map(([route, spec]) => ({
    route,
    ...spec,
  }));
  for (const pm of probedModels.slice(0, 20)) {
    const pmRoute = `${preset.provider}/${pm.id}`;
    if (upsertModels.some(u => u.route === pmRoute || u.upstreamModel === pm.id)) continue;
    const fam = inferModelFamily(pm.id, preset.provider);
    const inf = inferEffortsFromMetadata({ family: fam, modelId: pm.id, resolvedInfo: pm, fromEndpointOnly: true });
    upsertModels.push({
      route: pmRoute,
      provider: preset.provider,
      upstreamModel: pm.id,
      family: fam,
      label: pm.name || pm.id,
      efforts: inf.efforts,
      defaultEffort: inf.defaultEffort,
      ...(pm.contextWindow ? { contextWindow: pm.contextWindow } : {}),
      ...(pm.maxTokens ? { maxTokens: pm.maxTokens } : {}),
      ...(typeof pm.vision === 'boolean' ? { vision: pm.vision } : {}),
      enableInPool: true,
    });
  }
  const setRoles = Object.entries(starterCfg.roles).map(([role, roleSpec]) => ({
    role,
    ...roleSpec,
  }));

  applyModelConfigChanges(
    {
      upsertModels,
      poolSet: [...new Set([...starterCfg.team.executionPool, ...upsertModels.map(u => u.route)])],
      setRoles,
      leaderModelPolicy: 'follow',
    },
    {
      configFile: configPath,
      target: 'local',
      autoAlignRoleEfforts: true,
    },
  );

  // Also adjust maxActiveMembers in local override if requested by collaboration preset
  const localPath = path.join(path.dirname(configPath), 'leaderteam.local.json');
  if (fs.existsSync(localPath)) {
    try {
      const localObj = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      localObj.team = {
        ...(localObj.team || {}),
        maxActiveMembers: collab.maxActiveMembers,
      };
      writeFileAtomic(localPath, `${JSON.stringify(localObj, null, 2)}\n`);
    } catch {}
  }

  // Sync provider template, models, AND default leader model selection to BOTH live DSH `ctx` and `$DSH_HOME` files!
  const effectiveEnv = { ...env };
  if (cleanKey) effectiveEnv[preset.envVars[0]] = cleanKey;
  const providerTemplates = buildSoloProviderSettingsTemplates(effectiveEnv);
  const overrideProviderBaseUrls = {};
  if (effectiveBaseURL && providerTemplates[preset.provider]) {
    if (!preset.catalogRoute || effectiveBaseURL !== preset.defaultBaseURL) {
      providerTemplates[preset.provider].baseURL = effectiveBaseURL;
      overrideProviderBaseUrls[preset.provider] = effectiveBaseURL;
      if (!providerTemplates[preset.provider].api) {
        providerTemplates[preset.provider].api = preset.api || 'openai-completions';
      }
    }
  }
  const effCfg = loadConfig(configPath);
  const modelsToSync = Object.entries(effCfg.models ?? {})
    .filter(([route, spec]) => (spec.provider ?? effCfg.magpie?.provider) === preset.provider || route.startsWith(`${preset.provider}/`))
    .map(([route, spec]) => ({
      route,
      provider: spec.provider ?? preset.provider,
      upstreamModel: spec.upstreamModel ?? route,
      efforts: spec.efforts,
      ...(spec.reasoningEfforts ? { reasoningEfforts: spec.reasoningEfforts } : {}),
      vision: spec.vision,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
    }));
  const leaderTarget = resolveModelTarget(effCfg, effCfg.roles.leader.route, effCfg.roles.leader.effort);
  const dshSettingsSync = await syncUpstreamModelsToDshSettings(ctx, modelsToSync, preset.provider, {
    providerTemplates,
    overrideProviderBaseUrls,
    includeCompanionCatalogModels: true,
    leaderTarget,
    selectLeaderAsHostDefault: true,
    dshHome,
    persistToDshHome: Boolean(dshHome),
  }).catch(() => null);

  if (rt) {
    rt.config = effCfg;
  }

  const record = writePersistedOnboardingRecord(storageRoot, {
    selectedProviderId: preset.id,
    ...(keyResult?.maskedPreview ? { keyPreview: keyResult.maskedPreview } : {}),
    selectedCollabPreset: collab.id,
    defaultSessionMode: 'team',
    dismissed: false,
  });

  return {
    applied: true,
    provider: {
      id: preset.id,
      displayName: preset.displayName,
      envVar: preset.envVars[0],
      maskedKey: keyResult?.maskedPreview ?? record.keyPreview ?? null,
      reasoningRoute: customizedPreset.reasoningRoute,
      chatRoute: customizedPreset.chatRoute,
    },
    dshSettingsSync,
    collabPreset: collab,
    onboarding: record,
  };
}

export function recordOnboardingFirstTask({ storageRoot, sessionId = null, completed = true } = {}) {
  const nowIso = new Date().toISOString();
  return writePersistedOnboardingRecord(storageRoot, {
    ...(sessionId ? { firstSessionId: String(sessionId) } : {}),
    completed: Boolean(completed),
    completedAt: completed ? nowIso : null,
    dismissed: false,
  });
}

export function dismissOnboardingWizard({ storageRoot } = {}) {
  return writePersistedOnboardingRecord(storageRoot, {
    dismissed: true,
    dismissedAt: new Date().toISOString(),
  });
}
