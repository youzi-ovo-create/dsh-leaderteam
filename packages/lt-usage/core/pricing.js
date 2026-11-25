const DEFAULT_USD_TO_CNY = 6.71;

const rate = (inputPerM, cacheReadPerM, cacheWritePerM, outputPerM) => ({
  inputPerM,
  cacheReadPerM,
  cacheWritePerM,
  outputPerM
});

export const defaultPricing = {
  usdToCny: DEFAULT_USD_TO_CNY,
  routes: {
    'bailian-token-plan/qwen4-max-preview': {
      vendor: '阿里云百炼 (Alibaba Cloud Bailian)',
      label: 'Qwen4-Max Preview（Token Plan 预览·订阅扣额·即将下架）',
      currency: 'CNY',
      peak: rate(10, 0.5, 12.5, 30),
      offPeak: null,
      peakRule: null,
      note: '经百炼 Token Plan 预付资源包订阅扣额调用，非按量付费刊例；预览路由即将下架，单价沿用黄金历史口径作参考，不代表当前官方按量价。'
    },
    'auto/deepseek-v4.1-flash-1017': {
      vendor: 'DeepSeek 官方开放平台',
      label: 'DeepSeek V4.1 Flash',
      currency: 'CNY',
      peak: rate(2, 0.04, 0, 8),
      offPeak: rate(1, 0.02, 0, 4),
      peakRule: 'deepseek-cn',
      note: '官方峰谷分时（北京时间工作日 09:00–12:00、14:00–18:00 峰时，其余及周末谷时 5 折）；CNY 价≈官方 $0.30/$0.006/$1.20（峰）、$0.15/$0.003/$0.60（谷）按 6.71 折算。'
    },
    'zcode/GLM-5.3': {
      vendor: '智谱 AI 开放平台 (BigModel)',
      label: 'GLM-5.3',
      currency: 'CNY',
      peak: rate(8, 2, 0, 28),
      offPeak: null,
      peakRule: null,
      note: '智谱 BigModel 官方 GLM-5.3 标准按量刊例：输入 ¥8/M、缓存命中 ¥2/M、输出 ¥28/M；缓存存储限时免费。'
    },
    'zcode/GLM-5.3-Flash': {
      vendor: '智谱 AI 开放平台 (BigModel)',
      label: 'GLM-5.3-Flash',
      currency: 'CNY',
      peak: rate(0.8, 0.23, 0, 2.8),
      offPeak: null,
      peakRule: null,
      note: '智谱 BigModel 官方 GLM-5.3-Flash 性价比档刊例：输入 ¥0.8/M、缓存命中 ¥0.23/M、输出 ¥2.8/M；缓存存储限时免费。'
    },
    'codex/gpt-6.1-sol': {
      vendor: 'OpenAI API',
      label: 'GPT-6.1 Sol',
      currency: 'USD',
      peak: rate(2, 0.1, 0, 10),
      offPeak: null,
      peakRule: null,
      note: 'OpenAI 官方 gpt-6.1-sol Standard（≤272K）刊例：输入 $2/M、缓存命中 $0.10/M、输出含推理 $10/M。'
    },
    'codex/gpt-6.2-sol': {
      vendor: 'OpenAI API',
      label: 'GPT-6.2 Sol',
      currency: 'USD',
      peak: rate(2, 0.1, 0, 10),
      offPeak: null,
      peakRule: null,
      note: 'OpenAI 官方 API 刊例 $2/$0.10/$10（≤272K；>272K 为 $4/$0.20/$15）。注意：Codex 订阅内计价为 $0，与官方 API 等效成本不可混用；本工具按官方 API 刊例核算。'
    },
    'antigravity/gemini-4-carbon': {
      vendor: 'Google Gemini API',
      label: 'Gemini 4 Carbon',
      currency: 'USD',
      peak: rate(2, 0.1, 0, 10),
      offPeak: null,
      peakRule: null,
      note: '官方促销价 $2/$0.10/$10（至 2026-11-30；12-01 起 $4/$0.20/$20）；输出含思考 token，Gemini 4 仅隐式缓存（无缓存写入费）。'
    },
    'antigravity/gemini-4-argon': {
      vendor: 'Google Gemini API',
      label: 'Gemini 4 Argon',
      currency: 'USD',
      peak: rate(2, 0.1, 0, 10),
      offPeak: null,
      peakRule: null,
      note: '官方促销价 $2/$0.10/$10（至 2026-11-30；12-01 起 $4/$0.20/$20；Contributor 档 $1/$0.05/$5）；输出含思考 token，仅隐式缓存。'
    },
    'antigravity/gemini-3.8-flash': {
      vendor: 'Google Gemini API',
      label: 'Gemini 3.8 Flash',
      currency: 'USD',
      peak: rate(0.75, 0.075, 0, 3.75),
      offPeak: null,
      peakRule: null,
      note: '官方促销价 $0.75/$0.075/$3.75（至 2026-12-31；2027-01-01 起 $1.5/$0.15/$7.5）；输出含思考 token；3.x Flash 另有缓存存储费（按小时计，未计入每 Token 单价）。'
    }
  }
};

function usdToCnyOf(pricing) {
  const value = Number(pricing?.usdToCny);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_USD_TO_CNY;
}

function normalRate(source) {
  const clean = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    inputPerM: clean(source?.inputPerM),
    cacheReadPerM: clean(source?.cacheReadPerM),
    cacheWritePerM: clean(source?.cacheWritePerM),
    outputPerM: clean(source?.outputPerM)
  };
}

function sameRates(a, b) {
  return (
    a.inputPerM === b.inputPerM &&
    a.cacheReadPerM === b.cacheReadPerM &&
    a.cacheWritePerM === b.cacheWritePerM &&
    a.outputPerM === b.outputPerM
  );
}

export function normalizeRoute(route) {
  if (typeof route !== 'string') return 'unknown';
  const trimmed = route.trim();
  return trimmed || 'unknown';
}

export function lookupPricingEntry(route, pricing = defaultPricing) {
  const routes = pricing?.routes;
  if (!routes || typeof routes !== 'object') return null;
  const key = normalizeRoute(route);
  if (routes[key]) return { key, entry: routes[key] };
  // 剥离常见本地聚合网关前缀（如 magpie/）后二次匹配
  const stripped = key.replace(/^magpie\//i, '');
  if (stripped !== key && routes[stripped]) return { key: stripped, entry: routes[stripped] };
  return null;
}

export function isPeakCst(timeMs) {
  if (!Number.isFinite(timeMs)) return false;
  const shifted = new Date(timeMs + 8 * 3600e3);
  const day = shifted.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = shifted.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export function resolveRates(route, timeMs, pricing = defaultPricing) {
  const found = lookupPricingEntry(route, pricing);
  if (!found?.entry?.peak) return null;
  const entry = found.entry;
  const peak = normalRate(entry.peak);
  const configuredOffPeak = entry.offPeak ? normalRate(entry.offPeak) : null;
  const varies =
    entry.peakRule === 'deepseek-cn' && configuredOffPeak !== null && !sameRates(peak, configuredOffPeak);
  const offPeak = varies ? configuredOffPeak : peak;
  const actual = varies && !isPeakCst(timeMs) ? offPeak : peak;
  return { entry, matchedRoute: found.key, peak, offPeak, actual, varies, usdToCny: usdToCnyOf(pricing) };
}

export function costOfUsage(usage, rates) {
  const input = (usage?.inputTokens ?? 0) * rates.inputPerM;
  const cacheRead = (usage?.cacheReadTokens ?? 0) * rates.cacheReadPerM;
  const cacheWrite = (usage?.cacheWriteTokens ?? 0) * rates.cacheWritePerM;
  const output = (usage?.outputTokens ?? 0) * rates.outputPerM;
  return {
    input: input / 1e6,
    cacheRead: cacheRead / 1e6,
    cacheWrite: cacheWrite / 1e6,
    output: output / 1e6,
    total: (input + cacheRead + cacheWrite + output) / 1e6
  };
}

export function priceCall(usage, route, timeMs, pricing = defaultPricing) {
  const resolved = resolveRates(route, timeMs, pricing);
  if (!resolved) {
    return {
      peakCny: null,
      offPeakCny: null,
      actualCny: null,
      peakUsd: null,
      offPeakUsd: null,
      actualUsd: null,
      priced: false
    };
  }
  const peak = costOfUsage(usage, resolved.peak);
  const offPeak = costOfUsage(usage, resolved.offPeak);
  const actual = costOfUsage(usage, resolved.actual);
  const { usdToCny, entry } = resolved;
  if (entry.currency === 'USD') {
    return {
      peakUsd: peak.total,
      offPeakUsd: offPeak.total,
      actualUsd: actual.total,
      peakCny: peak.total * usdToCny,
      offPeakCny: offPeak.total * usdToCny,
      actualCny: actual.total * usdToCny,
      priced: true
    };
  }
  return {
    peakCny: peak.total,
    offPeakCny: offPeak.total,
    actualCny: actual.total,
    peakUsd: peak.total / usdToCny,
    offPeakUsd: offPeak.total / usdToCny,
    actualUsd: actual.total / usdToCny,
    priced: true
  };
}
