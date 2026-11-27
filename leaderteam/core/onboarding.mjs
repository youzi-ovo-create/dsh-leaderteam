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
  canonicalRouteFor,
  inferEffortsFromMetadata,
  inferModelFamily,
  parseUpstreamModelsPayload,
  resolveModelTarget,
  syncModelsToDshDiskProfiles,
  syncUpstreamModelsToDshSettings,
  writeDshCredentialsYamlEntry,
  readDshEnvCredentialsMap,
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
    id: 'single',
    label: '轻量单兵模式（快速上手）',
    defaultSessionMode: 'single',
    maxActiveMembers: 2,
    summary: '像普通 AI 编程助手一样直接对话、读写文件与运行命令，零子代理编排开销，适合小改动、阅读代码与快速问答；随时可在会话内一键切回 Team 模式。',
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
    recommendedMode: 'single',
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
      defaultSessionMode: raw.defaultSessionMode === 'single' ? 'single' : 'team',
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

/**
 * Persist an environment credential into `$DSH_HOME/.env` (mode 0600 on POSIX) as an official
 * `@deepseek-ai/dsh-credentials-local` ambient fallback, AND into live `ctx.credentials` when mounted.
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
      // Fallback to .env below if host credential store rejects or is read-only
    }
  }

  // 2. Also write/update `$DSH_HOME/.env` (mode 0600) so standalone `lt-ui` / `lt-installer` and restarts resolve it
  if (dshHome) {
    fsImpl.mkdirSync(dshHome, { recursive: true });
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
    // Also mirror into `$DSH_HOME/.credentials.yaml` (`version: 1`, `refs:`) so `@deepseek-ai/dsh-credentials-local`
    // (`fs.watch` live store) resolves `PiAiAdapter.listModels()` immediately even when configured from standalone UI/CLI!
    try {
      writeDshCredentialsYamlEntry({
        dshHome,
        envVarName: cleanVar,
        apiKey: cleanKey,
        fsImpl,
      });
    } catch {}
  }

  // 3. Keep current process env in sync for immediate Solo-Key template discovery
  if (env && typeof env === 'object') {
    env[cleanVar] = cleanKey;
  }

  return {
    envVarName: cleanVar,
    maskedPreview: maskKeyPreview(cleanKey),
    storedInHostCredentials,
    storedInDshEnvFile,
    storedInCredentialsYaml: Boolean(dshHome),
  };
}

function selectDiscoveredStarterPair(discoveredModels = [], providerId = '') {
  if (!Array.isArray(discoveredModels) || discoveredModels.length === 0) return null;
  const scoreReasoning = id => {
    const l = String(id).toLowerCase();
    if (/deepseek-v4-pro|deepseek-reasoner|deepseek-r1/.test(l)) return 100;
    if (/qwen3-max|qwen-max|qwq/.test(l)) return 95;
    if (/glm-5|glm-4\.5(?!-air)/.test(l)) return 92;
    if (/gpt-5|gpt-4\.1(?!-mini|-nano)|o3|o4|claude-opus|claude-sonnet/.test(l)) return 90;
    if (/reasoner|thinking|pro|max|opus/.test(l)) return 80;
    return 10;
  };
  const scoreChat = id => {
    const l = String(id).toLowerCase();
    if (/deepseek-flash|deepseek-chat|deepseek-v3/.test(l)) return 100;
    if (/qwen-plus|qwen-turbo|qwen2\.5-coder/.test(l)) return 95;
    if (/glm-4\.5-air|glm-4-flash|glm-4-plus/.test(l)) return 92;
    if (/gpt-4\.1-mini|gpt-4o-mini|o4-mini|claude-haiku/.test(l)) return 90;
    if (/flash|chat|plus|mini|air|turbo|coder/.test(l)) return 80;
    return 10;
  };
  const sortedReasoning = [...discoveredModels].sort((a, b) => scoreReasoning(b.id) - scoreReasoning(a.id));
  const reasoningModel = sortedReasoning[0];
  const sortedChat = [...discoveredModels].sort((a, b) => scoreChat(b.id) - scoreChat(a.id));
  const chatModel = sortedChat.find(m => m.id !== reasoningModel.id && scoreChat(m.id) >= 50)
    ?? sortedChat.find(m => m.id !== reasoningModel.id)
    ?? reasoningModel;
  return { reasoningModel, chatModel, providerId };
}

/**
 * Optional lightweight connectivity check against an OpenAI-compatible `/models` endpoint
 * with friendly Chinese diagnostics for beginners and real `/v1/models` list extraction.
 */
export async function probeProviderKeyConnectivity({
  baseURL,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: true, skipped: true, models: [], message: '当前环境不支持在线连通性预检，已跳过验证直接保存。' };
  }
  const cleanBase = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!cleanBase) {
    return { ok: false, code: 'INVALID_BASE_URL', models: [], message: '接口地址（Base URL）不能为空。' };
  }
  const primaryModelsUrl = /\/v\d+$/i.test(cleanBase)
    ? `${cleanBase}/models`
    : `${cleanBase}/v1/models`;
  const fallbackModelsUrl = !/\/v\d+$/i.test(cleanBase) && !cleanBase.endsWith('/models')
    ? `${cleanBase}/models`
    : null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const reqHeaders = {
      Authorization: `Bearer ${String(apiKey || '').trim()}`,
      Accept: 'application/json',
    };
    let res = await fetchImpl(primaryModelsUrl, {
      method: 'GET',
      headers: reqHeaders,
      signal: ac.signal,
    });
    if (res.status === 404 && fallbackModelsUrl) {
      const fallbackRes = await fetchImpl(fallbackModelsUrl, {
        method: 'GET',
        headers: reqHeaders,
        signal: ac.signal,
      }).catch(() => null);
      if (fallbackRes) res = fallbackRes;
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: 'AUTH_FAILED',
        status: res.status,
        models: [],
        message: 'API Key 验证未通过（HTTP ' + res.status + '）：请检查是否完整复制了有效的密钥，且没有多余空格。',
      };
    }
    if (res.status === 402) {
      return {
        ok: false,
        code: 'INSUFFICIENT_BALANCE',
        status: 402,
        models: [],
        message: '该 API Key 账户余额或免费额度不足（HTTP 402），请前往厂商控制台充值或检查额度。',
      };
    }
    if (!res.ok && res.status >= 500) {
      return {
        ok: false,
        code: 'UPSTREAM_ERROR',
        status: res.status,
        models: [],
        message: `上游模型服务暂时繁忙（HTTP ${res.status}），您可以稍后重试或直接保存配置。`,
      };
    }
    let discoveredModels = [];
    if (res.ok) {
      try {
        const bodyJson = await res.json();
        discoveredModels = parseUpstreamModelsPayload(bodyJson);
      } catch {}
    }
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
      models: [],
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
  collabPresetId = 'balanced-team',
  verifyConnectivity = false,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const preset = SOLO_PROVIDER_PRESETS.find(p => p.id === providerId || p.provider === providerId) ?? SOLO_PROVIDER_PRESETS[0];
  const collab = TEAM_COLLAB_PRESETS.find(c => c.id === collabPresetId) ?? TEAM_COLLAB_PRESETS[0];
  const cleanKey = String(apiKey ?? '').trim();
  const hasExplicitCustomBaseURL = Boolean(String(customBaseURL ?? '').trim());
  const effectiveBaseURL = String(customBaseURL ?? '').trim() || preset.defaultBaseURL;

  let endpointDiscoveredModels = [];
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
      endpointDiscoveredModels = probe.models;
    }
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
  } else if (dshHome) {
    // If key was already present in process.env or `$DSH_HOME/.env`, ensure `.credentials.yaml` also has it
    const ambientMap = readDshEnvCredentialsMap({ dshHome, env });
    const existingEnvVar = preset.envVars.find(v => ambientMap[v]);
    if (existingEnvVar) {
      try {
        writeDshCredentialsYamlEntry({
          dshHome,
          envVarName: existingEnvVar,
          apiKey: ambientMap[existingEnvVar],
          onlyIfMissing: true,
        });
      } catch {}
    }
  }

  const baseRaw = JSON.parse(fs.readFileSync(bundledDefaultConfigPath, 'utf8'));
  let effectivePreset = hasExplicitCustomBaseURL
    ? { ...preset, defaultBaseURL: effectiveBaseURL }
    : preset;

  // When live `/v1/models` returned real model IDs and the static preset's models aren't served by this endpoint
  // (e.g. `deepseek-reasoner` + `deepseek-chat` or custom OpenAI-compatible gateway models), adapt starter routes automatically!
  if (endpointDiscoveredModels.length > 0) {
    const discoveredIdSet = new Set(endpointDiscoveredModels.map(m => m.id));
    const staticReasoningUpstream = preset.models?.[preset.reasoningRoute]?.upstreamModel ?? preset.reasoningRoute;
    const staticChatUpstream = preset.models?.[preset.chatRoute]?.upstreamModel ?? preset.chatRoute;
    const pair = selectDiscoveredStarterPair(endpointDiscoveredModels, preset.provider);
    if (pair && (!discoveredIdSet.has(staticReasoningUpstream) || !discoveredIdSet.has(staticChatUpstream))) {
      const adaptedModels = {};
      let adaptedReasoningRoute = null;
      let adaptedChatRoute = null;
      for (const dm of endpointDiscoveredModels.slice(0, 25)) {
        const route = canonicalRouteFor(preset.provider, dm.id, {
          defaultProvider: preset.provider,
          existingModels: adaptedModels,
        });
        if (!route) continue;
        const family = inferModelFamily(dm.id, preset.provider);
        const effMeta = inferEffortsFromMetadata({
          family,
          modelId: dm.id,
          resolvedInfo: dm,
          fromEndpointOnly: true,
        });
        adaptedModels[route] = {
          provider: preset.provider,
          upstreamModel: dm.id,
          family,
          label: dm.name || dm.id,
          efforts: effMeta.efforts,
          defaultEffort: effMeta.defaultEffort,
          strengths: `Discovered from ${preset.displayName} (/v1/models)`,
          ...(typeof dm.vision === 'boolean' ? { vision: dm.vision } : {}),
          ...(dm.contextWindow ? { contextWindow: dm.contextWindow } : {}),
          ...(dm.maxTokens ? { maxTokens: dm.maxTokens } : {}),
        };
        if (dm.id === pair.reasoningModel.id) adaptedReasoningRoute = route;
        if (dm.id === pair.chatModel.id) adaptedChatRoute = route;
      }
      if (adaptedReasoningRoute && adaptedChatRoute) {
        effectivePreset = {
          ...effectivePreset,
          reasoningRoute: adaptedReasoningRoute,
          reasoningLabel: adaptedModels[adaptedReasoningRoute].label,
          reasoningEffort: adaptedModels[adaptedReasoningRoute].defaultEffort || 'none',
          chatRoute: adaptedChatRoute,
          chatLabel: adaptedModels[adaptedChatRoute].label,
          chatEffort: adaptedModels[adaptedChatRoute].defaultEffort || 'none',
          models: adaptedModels,
        };
      }
    }
  }

  const starterCfg = buildSoloKeyStarterConfig(baseRaw, { preset: effectivePreset });

  // Also include any additional models discovered from `/v1/models` so all endpoint models appear in DSH & LT selectors
  if (endpointDiscoveredModels.length > 0) {
    for (const dm of endpointDiscoveredModels.slice(0, 25)) {
      const route = canonicalRouteFor(preset.provider, dm.id, {
        defaultProvider: preset.provider,
        existingModels: starterCfg.models,
      });
      if (!route || starterCfg.models[route]) continue;
      const family = inferModelFamily(dm.id, preset.provider);
      const effMeta = inferEffortsFromMetadata({
        family,
        modelId: dm.id,
        resolvedInfo: dm,
        fromEndpointOnly: true,
      });
      starterCfg.models[route] = {
        provider: preset.provider,
        upstreamModel: dm.id,
        family,
        label: dm.name || dm.id,
        efforts: effMeta.efforts,
        defaultEffort: effMeta.defaultEffort,
        strengths: `Discovered from ${preset.displayName} (/v1/models)`,
        ...(typeof dm.vision === 'boolean' ? { vision: dm.vision } : {}),
        ...(dm.contextWindow ? { contextWindow: dm.contextWindow } : {}),
        ...(dm.maxTokens ? { maxTokens: dm.maxTokens } : {}),
      };
    }
  }

  const upsertModels = Object.entries(starterCfg.models).map(([route, spec]) => ({
    route,
    ...spec,
  }));
  const setRoles = Object.entries(starterCfg.roles).map(([role, roleSpec]) => ({
    role,
    ...roleSpec,
  }));

  if (configPath && !fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(starterCfg, null, 2)}\n`);
  }

  applyModelConfigChanges(
    {
      upsertModels,
      poolSet: starterCfg.team.executionPool,
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

  // Sync provider template, models & default leader model to BOTH live DSH `ctx` AND `$DSH_HOME/profiles/*/cordis.patch.yml`!
  const effectiveEnv = { ...readDshEnvCredentialsMap({ dshHome, env }), ...env };
  if (cleanKey) effectiveEnv[preset.envVars[0]] = cleanKey;
  const providerTemplates = buildSoloProviderSettingsTemplates(effectiveEnv);
  if (effectiveBaseURL && providerTemplates[preset.provider]) {
    if (hasExplicitCustomBaseURL || !preset.catalogRoute) {
      providerTemplates[preset.provider].baseURL = effectiveBaseURL;
    }
    if (hasExplicitCustomBaseURL) {
      providerTemplates[preset.provider].forceBaseURL = true;
      providerTemplates[preset.provider].api = providerTemplates[preset.provider].api || preset.api || 'openai-completions';
    }
  }

  const effCfg = loadConfig(configPath);
  const modelsToSync = Object.entries(effCfg.models ?? {}).map(([route, spec]) => ({
    route,
    provider: spec.provider ?? preset.provider,
    upstreamModel: spec.upstreamModel ?? route,
    efforts: spec.efforts,
    ...(spec.reasoningEfforts ? { reasoningEfforts: spec.reasoningEfforts } : {}),
    vision: spec.vision,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  }));
  const defaultLeaderSelection = effCfg.roles?.leader?.route
    ? resolveModelTarget(effCfg, effCfg.roles.leader.route, effCfg.roles.leader.effort)
    : null;

  let dshSettingsSync = { synced: false, reason: 'not-run', updatedProviders: [] };
  if (ctx) {
    dshSettingsSync = await syncUpstreamModelsToDshSettings(ctx, modelsToSync, preset.provider, {
      providerTemplates,
      defaultSelection: defaultLeaderSelection,
      syncDefaultModel: true,
    }).catch(err => ({ synced: false, reason: err instanceof Error ? err.message : String(err), updatedProviders: [] }));
  }
  let diskProfileSync = null;
  if (dshHome) {
    diskProfileSync = syncModelsToDshDiskProfiles({
      dshHome,
      modelsToEnsure: modelsToSync,
      defaultProvider: preset.provider,
      providerTemplates,
      defaultSelection: defaultLeaderSelection,
      syncDefaultModel: true,
      createDefaultProfilesIfNone: true,
    });
  }

  if (rt) {
    rt.config = effCfg;
  }

  const record = writePersistedOnboardingRecord(storageRoot, {
    selectedProviderId: preset.id,
    ...(keyResult?.maskedPreview ? { keyPreview: keyResult.maskedPreview } : {}),
    selectedCollabPreset: collab.id,
    defaultSessionMode: collab.defaultSessionMode,
    dismissed: false,
  });

  return {
    applied: true,
    provider: {
      id: preset.id,
      displayName: preset.displayName,
      envVar: preset.envVars[0],
      maskedKey: keyResult?.maskedPreview ?? record.keyPreview ?? null,
      reasoningRoute: effectivePreset.reasoningRoute,
      chatRoute: effectivePreset.chatRoute,
    },
    dshSync: {
      liveHostSynced: Boolean(dshSettingsSync?.synced),
      diskProfilesSynced: Boolean(diskProfileSync?.synced),
      updatedProfiles: diskProfileSync?.updatedProfiles ?? [],
    },
    collabPreset: collab,
    onboarding: record,
  };
}

export function recordOnboardingFirstTask({ storageRoot, sessionId, completed = true }) {
  return writePersistedOnboardingRecord(storageRoot, {
    completed: Boolean(completed),
    dismissed: false,
    completedAt: completed ? new Date().toISOString() : null,
    ...(sessionId ? { firstSessionId: String(sessionId) } : {}),
  });
}

export function dismissOnboardingWizard({ storageRoot }) {
  return writePersistedOnboardingRecord(storageRoot, {
    dismissed: true,
    dismissedAt: new Date().toISOString(),
  });
}
