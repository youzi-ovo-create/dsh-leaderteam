// Solo-Key starter configuration & zero-config bootstrap for standard `dsh.bundle` installations.
// Allows new users on Linux or Windows to run LeaderTeam with a single API key (e.g. DEEPSEEK_API_KEY)
// without setting up a local Magpie gateway, while preserving full multi-gateway customization.
import fs from 'node:fs';
import path from 'node:path';

export const SOLO_PROVIDER_PRESETS = Object.freeze([
  {
    id: 'deepseek',
    envVars: ['DEEPSEEK_API_KEY'],
    provider: 'deepseek',
    displayName: 'DeepSeek',
    catalogRoute: false,
    api: 'openai-completions',
    defaultBaseURL: 'https://api.deepseek.com',
    family: 'deepseek',
    reasoningRoute: 'deepseek/deepseek-v4-pro',
    reasoningLabel: 'DeepSeek V4 Pro',
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'max'],
    reasoningDefaultEffort: 'high',
    reasoningContextWindow: 1000000,
    reasoningMaxTokens: 65536,
    reasoningVision: false,
    reasoningCompat: {
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    chatRoute: 'deepseek/deepseek-flash',
    chatLabel: 'DeepSeek Flash',
    chatEfforts: ['none'],
    chatDefaultEffort: 'none',
    chatContextWindow: 1000000,
    chatMaxTokens: 65536,
    chatVision: true,
    chatCompat: {
      supportsStore: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
    },
  },
  {
    id: 'dashscope',
    envVars: ['DASHSCOPE_API_KEY', 'BAILIAN_API_KEY'],
    provider: 'dashscope',
    displayName: 'DashScope (Qwen)',
    catalogRoute: false,
    api: 'openai-completions',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    family: 'qwen',
    reasoningRoute: 'dashscope/qwen-max',
    reasoningLabel: 'Qwen Max (DashScope)',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    reasoningDefaultEffort: 'high',
    reasoningContextWindow: 131072,
    reasoningMaxTokens: 16384,
    chatRoute: 'dashscope/qwen-plus',
    chatLabel: 'Qwen Plus (DashScope)',
    chatEfforts: ['none'],
    chatDefaultEffort: 'none',
    chatContextWindow: 131072,
    chatMaxTokens: 16384,
  },
  {
    id: 'zhipu',
    envVars: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    provider: 'zhipu',
    displayName: 'Zhipu (GLM)',
    catalogRoute: false,
    api: 'openai-completions',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    family: 'glm',
    reasoningRoute: 'zhipu/glm-4.5',
    reasoningLabel: 'GLM-4.5 (Zhipu)',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    reasoningDefaultEffort: 'high',
    reasoningContextWindow: 128000,
    reasoningMaxTokens: 16384,
    chatRoute: 'zhipu/glm-4.5-air',
    chatLabel: 'GLM-4.5 Air (Zhipu)',
    chatEfforts: ['none'],
    chatDefaultEffort: 'none',
    chatContextWindow: 128000,
    chatMaxTokens: 16384,
  },
  {
    id: 'openai',
    envVars: ['OPENAI_API_KEY'],
    provider: 'openai',
    displayName: 'OpenAI',
    catalogRoute: true,
    defaultBaseURL: 'https://api.openai.com/v1',
    family: 'gpt',
    reasoningRoute: 'openai/gpt-4.1',
    reasoningLabel: 'GPT-4.1 (OpenAI)',
    reasoningEfforts: ['none'],
    reasoningDefaultEffort: 'none',
    reasoningContextWindow: 1000000,
    reasoningMaxTokens: 32768,
    chatRoute: 'openai/gpt-4.1-mini',
    chatLabel: 'GPT-4.1 Mini (OpenAI)',
    chatEfforts: ['none'],
    chatDefaultEffort: 'none',
    chatContextWindow: 1000000,
    chatMaxTokens: 32768,
  },
]);

/** Build DSH `llm-pi-ai` provider templates keyed by provider id so clean profiles auto-register Solo-Key routes. Pure. */
export function buildSoloProviderSettingsTemplates(env = process.env) {
  const templates = {};
  for (const preset of SOLO_PROVIDER_PRESETS) {
    const activeEnvVar = preset.envVars.find(k => typeof env?.[k] === 'string' && env[k].trim().length > 0) ?? preset.envVars[0];
    templates[preset.provider] = {
      displayName: preset.displayName ?? preset.provider,
      apiKeyEnv: activeEnvVar,
      ...(preset.catalogRoute ? {} : { api: preset.api ?? 'openai-completions', baseURL: preset.defaultBaseURL }),
      modelMetadata: {
        [preset.reasoningRoute.slice(preset.provider.length + 1)]: {
          ...(preset.reasoningContextWindow ? { contextWindow: preset.reasoningContextWindow } : {}),
          ...(preset.reasoningMaxTokens ? { maxTokens: preset.reasoningMaxTokens } : {}),
          ...(preset.reasoningCompat ? { compat: preset.reasoningCompat } : {}),
        },
        [preset.chatRoute.slice(preset.provider.length + 1)]: {
          ...(preset.chatContextWindow ? { contextWindow: preset.chatContextWindow } : {}),
          ...(preset.chatMaxTokens ? { maxTokens: preset.chatMaxTokens } : {}),
          ...(preset.chatCompat ? { compat: preset.chatCompat } : {}),
        },
      },
    };
  }
  return templates;
}

/** Detect a single-provider starter candidate from environment variables or explicit preset id. Pure. */
export function detectSoloKeyPreset({ presetId = null, env = process.env } = {}) {
  if (typeof presetId === 'string' && presetId.trim()) {
    const clean = presetId.trim().toLowerCase();
    const matched = SOLO_PROVIDER_PRESETS.find(p => p.id === clean || p.provider === clean);
    if (matched) return { preset: matched, detectedBy: 'explicit' };
  }
  const explicitEnv = typeof env?.LT_SOLO_PROVIDER === 'string' ? env.LT_SOLO_PROVIDER.trim().toLowerCase() : '';
  if (explicitEnv) {
    const matched = SOLO_PROVIDER_PRESETS.find(p => p.id === explicitEnv || p.provider === explicitEnv);
    if (matched) return { preset: matched, detectedBy: 'LT_SOLO_PROVIDER' };
  }
  for (const preset of SOLO_PROVIDER_PRESETS) {
    const hitVar = preset.envVars.find(k => typeof env?.[k] === 'string' && env[k].trim().length > 0);
    if (hitVar) return { preset, detectedBy: hitVar };
  }
  return null;
}

/** Build a schema-valid Solo-Key starter configuration from the shipped base config. Pure. */
export function buildSoloKeyStarterConfig(baseRawConfig, { preset = SOLO_PROVIDER_PRESETS[0] } = {}) {
  const cfg = structuredClone(baseRawConfig);
  const rRoute = preset.reasoningRoute;
  const cRoute = preset.chatRoute;
  const stripProv = route => route.startsWith(`${preset.provider}/`) ? route.slice(preset.provider.length + 1) : route;
  const rUpstream = preset.reasoningUpstreamModel ?? stripProv(rRoute);
  const cUpstream = preset.chatUpstreamModel ?? stripProv(cRoute);
  const rEffort = preset.reasoningDefaultEffort;
  const cEffort = preset.chatDefaultEffort;
  const rLowEffort = preset.reasoningEfforts.includes('low') ? 'low' : rEffort;

  cfg.magpie = { provider: preset.provider };
  cfg.models = {
    [rRoute]: {
      provider: preset.provider,
      upstreamModel: rUpstream,
      family: preset.family,
      label: preset.reasoningLabel,
      efforts: [...preset.reasoningEfforts],
      defaultEffort: rEffort,
      ...(preset.reasoningContextWindow ? { contextWindow: preset.reasoningContextWindow } : {}),
      ...(preset.reasoningMaxTokens ? { maxTokens: preset.reasoningMaxTokens } : {}),
      strengths: '全局规划、复杂模块实现、独立安全复核与争议裁断',
      vision: Boolean(preset.reasoningVision),
    },
    ...(cRoute !== rRoute ? {
      [cRoute]: {
        provider: preset.provider,
        upstreamModel: cUpstream,
        family: preset.family,
        label: preset.chatLabel,
        efforts: [...preset.chatEfforts],
        defaultEffort: cEffort,
        ...(preset.chatContextWindow ? { contextWindow: preset.chatContextWindow } : {}),
        ...(preset.chatMaxTokens ? { maxTokens: preset.chatMaxTokens } : {}),
        strengths: '高频代码实现、测试编写、直属执行与快速验证',
        vision: Boolean(preset.chatVision),
      },
    } : {}),
  };

  const fallbackChain = cRoute !== rRoute ? [{ route: cRoute, effort: cEffort, timeoutMs: 120000, retries: 1 }] : [];
  const reverseFallback = cRoute !== rRoute ? [{ route: rRoute, effort: rLowEffort, timeoutMs: 180000, retries: 1 }] : [];

  cfg.roles = {
    leader: { route: rRoute, effort: rEffort },
    gate: { route: cRoute, effort: cEffort, maxTokens: 4000, timeoutMs: 90000, retries: 1, fallback: reverseFallback },
    discussA: { route: rRoute, effort: rEffort, maxTokens: 8000, timeoutMs: 300000, retries: 1, fallback: fallbackChain },
    discussB: { route: cRoute, effort: cEffort, maxTokens: 8000, timeoutMs: 300000, retries: 1, fallback: reverseFallback },
    arbiter: { route: rRoute, effort: rEffort, maxTokens: 16000, timeoutMs: 600000, retries: 1, fallback: fallbackChain },
    serialReviewer: { route: cRoute, effort: cEffort, maxTokens: 2400, timeoutMs: 120000, retries: 1, fallback: reverseFallback },
    directExec: { route: cRoute, effort: cEffort, timeoutMs: 180000, retries: 1, fallback: reverseFallback },
  };

  cfg.team = {
    ...cfg.team,
    leaderModelPolicy: 'warn',
    executionPool: cRoute !== rRoute ? [cRoute, rRoute] : [rRoute],
    autoIncludeUpstreamModels: true,
    disabledModels: [],
    disabledFamilies: [],
  };

  cfg.quota = {
    ...cfg.quota,
    stateFile: null,
    allowUnknown: true,
    allowUnknownGpt: preset.family === 'gpt',
  };

  return cfg;
}

/**
 * Resolve or auto-initialize the LeaderTeam config file when launched as a standard `dsh.bundle`
 * without an explicit `configPath`. Writes atomically under `<dshHome>/leaderteam/config/`.
 */
export function resolveOrBootstrapConfigPath({
  explicitConfigPath = null,
  env = process.env,
  dshHome = null,
  bundledDefaultConfigPath,
}) {
  if (typeof explicitConfigPath === 'string' && explicitConfigPath.trim()) {
    return { configPath: explicitConfigPath.trim(), bootstrapped: false, mode: 'explicit' };
  }
  if (typeof env?.LEADERTEAM_CONFIG === 'string' && env.LEADERTEAM_CONFIG.trim()) {
    return { configPath: env.LEADERTEAM_CONFIG.trim(), bootstrapped: false, mode: 'env' };
  }
  if (!dshHome) {
    if (bundledDefaultConfigPath && fs.existsSync(bundledDefaultConfigPath)) {
      return { configPath: bundledDefaultConfigPath, bootstrapped: false, mode: 'bundled-fallback' };
    }
    throw new Error('leaderteam-core: cannot resolve configPath (neither config.configPath, LEADERTEAM_CONFIG, nor DSH_HOME is available)');
  }

  const managedDir = path.join(dshHome, 'leaderteam', 'config');
  const managedFile = path.join(managedDir, 'leaderteam.config.json');
  if (fs.existsSync(managedFile)) {
    return { configPath: managedFile, bootstrapped: false, mode: 'managed-existing' };
  }

  const baseRaw = JSON.parse(fs.readFileSync(bundledDefaultConfigPath, 'utf8'));
  const soloHit = detectSoloKeyPreset({ env });
  let initialCfg;
  let mode;
  if (soloHit) {
    initialCfg = buildSoloKeyStarterConfig(baseRaw, { preset: soloHit.preset });
    mode = `solo-${soloHit.preset.id}`;
  } else {
    // Default to Solo-DeepSeek starter template with warn policy + upstream model auto-inclusion
    // so standard `dsh plugin add` users are never blocked by non-existent `codex/` or `magpie` routes!
    initialCfg = buildSoloKeyStarterConfig(baseRaw, { preset: SOLO_PROVIDER_PRESETS[0] });
    mode = 'solo-deepseek-default';
  }

  fs.mkdirSync(managedDir, { recursive: true });
  const tmpFile = `${managedFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(initialCfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, managedFile);
  return { configPath: managedFile, bootstrapped: true, mode };
}
