// 官方 API 刊例参考库（2026-11-23 复核，每 100 万 tokens，标准在线推理·短上下文·按量付费，不含税/订阅）。
// 仅供价格表编辑器选用与未定价路由预填；长上下文/批量/优先队列另行分档，促销到期见各条 note。
// 与 defaultPricing 解耦：defaultPricing 是实盘内置价目，本库是可选参考全集。

const rate = (inputPerM, cacheReadPerM, cacheWritePerM, outputPerM) => ({
  inputPerM,
  cacheReadPerM,
  cacheWritePerM,
  outputPerM
});

const model = (id, label, currency, peak, opts = {}) => ({
  model: id,
  label,
  currency,
  peak,
  offPeak: opts.offPeak ?? null,
  peakRule: opts.peakRule ?? null,
  note: opts.note ?? '',
  aliases: opts.aliases ?? [id]
});

export const pricingCatalog = [
  {
    vendor: 'OpenAI',
    billing: 'USD',
    models: [
      model('gpt-6.2-astra', 'GPT-6.2 Astra', 'USD', rate(8, 0.4, 0, 40), { note: '>272K 整单落档 16/0.80/60；Batch/Flex 约 5 折，Fast 约 2 倍。' }),
      model('gpt-6.2-sol', 'GPT-6.2 Sol', 'USD', rate(2, 0.1, 0, 10), { note: '>272K 为 4/0.20/15。Codex 订阅内计价 $0 与官方 API 刊例不可混用。', aliases: ['gpt-6.2-sol', 'codex/gpt-6.2-sol'] }),
      model('gpt-6-astra', 'GPT-6 Astra', 'USD', rate(10, 1, 0, 50), { note: '>272K 为 20/2/75。' }),
      model('gpt-6.1-terra', 'GPT-6.1 Terra', 'USD', rate(1, 0.05, 0, 5)),
      model('gpt-6.1-sol', 'GPT-6.1 Sol', 'USD', rate(2, 0.1, 0, 10), { note: 'Standard ≤272K 黄金口径；2026-11-23 刊例表未单列此型号，沿用历史对标价。', aliases: ['gpt-6.1-sol', 'codex/gpt-6.1-sol'] }),
      model('gpt-6-luna', 'GPT-6 Luna', 'USD', rate(0.1, 0.01, 0, 0.5), { note: '最便宜的 GPT-6 系。' }),
      model('gpt-5.5', 'GPT-5.5', 'USD', rate(5, 0.5, 0, 30)),
      model('gpt-5.4', 'GPT-5.4', 'USD', rate(2.5, 0.25, 0, 15), { note: 'pro 版 30/180。' }),
      model('gpt-5.2', 'GPT-5.2', 'USD', rate(1.75, 0, 0, 14), { note: '刊例未单列缓存命中价。' }),
      model('gpt-5.1', 'GPT-5.1', 'USD', rate(1.25, 0.125, 0, 10)),
      model('gpt-5-mini', 'GPT-5 mini', 'USD', rate(0.25, 0, 0, 2), { note: '刊例未单列缓存命中价。' }),
      model('gpt-4.1', 'GPT-4.1', 'USD', rate(2, 0.5, 0, 8)),
      model('gpt-4o-mini', 'GPT-4o mini', 'USD', rate(0.15, 0.075, 0, 0.6)),
      model('o3', 'o3', 'USD', rate(2, 0, 0, 8), { note: 'o3-pro 20/80；刊例未单列缓存命中价。' })
    ]
  },
  {
    vendor: 'Anthropic',
    billing: 'USD',
    models: [
      model('fable-5.2', 'Fable 5.2', 'USD', rate(8, 0.2, 10, 40), { note: '缓存写入 5m/1h = 10/16；Fast 模式 16/80；思考 token 按输出价。' }),
      model('opus-5.5', 'Opus 5.5', 'USD', rate(4, 0.2, 5, 20), { note: '缓存写入 5m/1h = 5/8。' }),
      model('sonnet-5.5', 'Sonnet 5.5', 'USD', rate(2, 0.1, 2.5, 10), { note: '缓存写入 5m/1h = 2.50/4。' }),
      model('haiku-5.5', 'Haiku 5.5 (≤100K)', 'USD', rate(0.1, 0.01, 0.125, 0.5), { note: '>100K 整单 0.5/0.05/2.5，缓存写 0.625/1.0。' }),
      model('opus-5', 'Opus 5 / 4.8', 'USD', rate(5, 0.5, 6.25, 25), { note: '缓存写入 5m/1h = 6.25/10。' }),
      model('sonnet-4.6', 'Sonnet 4.6', 'USD', rate(3, 0.3, 3.75, 15), { note: '缓存写入 5m/1h = 3.75/6。' }),
      model('haiku-4.5', 'Haiku 4.5', 'USD', rate(1, 0.1, 1.25, 5), { note: '缓存写入 5m/1h = 1.25/2.0；Claude 4.7+ 分词器使同样文本约多 30% token。' })
    ]
  },
  {
    vendor: 'Google Gemini',
    billing: 'USD',
    models: [
      model('gemini-4-carbon', 'Gemini 4 Carbon', 'USD', rate(2, 0.1, 0, 10), { note: '促销至 2026-11-30；12-01 起 4/0.20/20。输出含思考 token，仅隐式缓存。', aliases: ['gemini-4-carbon', 'antigravity/gemini-4-carbon'] }),
      model('gemini-4-argon', 'Gemini 4 Argon', 'USD', rate(2, 0.1, 0, 10), { note: '促销至 2026-11-30；12-01 起 4/0.20/20；Contributor 档 1/0.05/5。', aliases: ['gemini-4-argon', 'antigravity/gemini-4-argon'] }),
      model('gemini-4-neon', 'Gemini 4 Neon', 'USD', rate(3, 0.15, 0, 15)),
      model('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'USD', rate(1.5, 0.075, 0, 7.5)),
      model('gemini-3.8-flash', 'Gemini 3.8 Flash', 'USD', rate(0.75, 0.075, 0, 3.75), { note: '促销至 2026-12-31；2027-01-01 起 1.5/0.15/7.5。3.x Flash 另有缓存存储费 0.5→1.0 USD/1M token/小时。', aliases: ['gemini-3.8-flash', 'antigravity/gemini-3.8-flash'] }),
      model('gemini-3.6-flash', 'Gemini 3.6 Flash', 'USD', rate(0.75, 0.075, 0, 3.75), { note: '同 3.8 Flash 促销与存储费。' }),
      model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'USD', rate(0.3, 0.03, 0, 2.5))
    ]
  },
  {
    vendor: 'xAI Grok',
    billing: 'USD',
    models: [
      model('grok-4.7', 'Grok 4.7 (<200K)', 'USD', rate(2, 0.5, 0, 6), { note: '≥200K 整单 4/1/12。' }),
      model('grok-4.5', 'Grok 4.5 (<200K)', 'USD', rate(2, 0.3, 0, 6), { note: '≥200K 整单 4/0.60/12。' }),
      model('grok-4.3', 'Grok 4.3 (<200K)', 'USD', rate(1.25, 0.2, 0, 2.5), { note: '≥200K 整单 2.50/0.40/5。' }),
      model('grok-4.20', 'Grok 4.20', 'USD', rate(1.25, 0.2, 0, 2.5), { note: '≥200K 整单 2.50/0.40/5。' }),
      model('grok-build-0.1', 'Grok Build 0.1', 'USD', rate(1, 0.2, 0, 2))
    ]
  },
  {
    vendor: 'DeepSeek',
    billing: 'USD',
    models: [
      model('deepseek-flash', 'DeepSeek Flash（峰谷）', 'USD', rate(0.3, 0.006, 0, 1.2), { offPeak: rate(0.15, 0.003, 0, 0.6), peakRule: 'deepseek-cn', note: '北京时间工作日 09:00–12:00、14:00–18:00 峰时，其余及周末谷时 5 折。', aliases: ['deepseek-flash', 'auto/deepseek-v4.1-flash-1017'] }),
      model('deepseek-v4-pro', 'DeepSeek V4 Pro（峰谷）', 'USD', rate(1.32, 0.044, 0, 3.96), { offPeak: rate(0.66, 0.022, 0, 1.98), peakRule: 'deepseek-cn', note: '峰谷时段同 deepseek-flash。' })
    ]
  },
  {
    vendor: '阿里云 Qwen',
    billing: 'CNY',
    models: [
      model('qwen4-max', 'Qwen4-Max', 'CNY', rate(10, 1, 0, 30), { note: '1M 上下文；缓存命中按输入 10%（=¥1/M）；按总输入落档整单计价，输出含思考。' }),
      model('qwen3.8-max', 'Qwen3.8-Max', 'CNY', rate(12, 1.2, 0, 36), { note: '缓存命中按输入 10%。' }),
      model('qwen3.7-plus', 'Qwen3.7-Plus (≤256K)', 'CNY', rate(2, 0.2, 0, 8), { note: '限时 8 折 →1.6/6.4；256K–1M 档 6/24（限时 4.8/19.2）。' }),
      model('qwen3.8-flash', 'Qwen3.8-Flash', 'CNY', rate(0.8, 0.08, 0, 2.7), { note: '1M 上下文；缓存命中按输入 10%。' }),
      model('qwen-plus', 'Qwen-Plus', 'CNY', rate(0.8, 0.08, 0, 2), { note: '≤128K 非思考输出 2，思考输出 8。' }),
      model('qwen-max', 'Qwen-Max', 'CNY', rate(2.4, 0.24, 0, 9.6), { note: '32K 非思考。' })
    ]
  },
  {
    vendor: '智谱 GLM',
    billing: 'CNY',
    models: [
      model('GLM-5.3', 'GLM-5.3', 'CNY', rate(8, 2, 0, 28), { note: '1M；缓存存储限时免费。', aliases: ['GLM-5.3', 'zcode/GLM-5.3'] }),
      model('GLM-5.3-Flash', 'GLM-5.3-Flash', 'CNY', rate(0.8, 0.23, 0, 2.8), { note: '性价比档；缓存存储限时免费。', aliases: ['GLM-5.3-Flash', 'zcode/GLM-5.3-Flash'] }),
      model('GLM-5.3-FlashX', 'GLM-5.3-FlashX', 'CNY', rate(2, 0.57, 0, 7)),
      model('GLM-5.2', 'GLM-5.2', 'CNY', rate(8, 2, 0, 28)),
      model('GLM-5.1', 'GLM-5.1', 'CNY', rate(6, 1.3, 0, 24), { note: '<32K；≥32K 整单 8/2/28。' }),
      model('GLM-4.7', 'GLM-4.7', 'CNY', rate(2, 0.4, 0, 8), { note: '≤32K 短输出；32K–200K 为 4/0.8/16；另按输出是否 ≥0.2K 细分。' }),
      model('GLM-4.7-Flash', 'GLM-4.7-Flash', 'CNY', rate(0, 0, 0, 0), { note: '官方免费。' }),
      model('GLM-4.5-Air', 'GLM-4.5-Air', 'CNY', rate(0.8, 0, 0, 2), { note: '刊例未单列缓存命中价。' })
    ]
  },
  {
    vendor: '字节 Doubao（火山方舟）',
    billing: 'CNY',
    models: [
      model('doubao-seed-evolving', 'Doubao Seed Evolving', 'CNY', rate(6, 1.2, 0, 30), { note: '1,024K；缓存存储 0.017 元/1M token/小时；低优约 5 折。' }),
      model('doubao-seed-2.1-pro', 'Doubao Seed 2.1 Pro', 'CNY', rate(6, 1.2, 0, 30), { note: '1,024K。' }),
      model('doubao-seed-2.1-lite', 'Doubao Seed 2.1 Lite', 'CNY', rate(0.8, 0.16, 0, 2.7), { note: '文本；音频输入 12。' }),
      model('doubao-seed-2.1-turbo', 'Doubao Seed 2.1 Turbo', 'CNY', rate(3, 0.6, 0, 15), { note: '256K。' }),
      model('doubao-seed-2.0-pro', 'Doubao Seed 2.0 Pro', 'CNY', rate(3.2, 0.64, 0, 16), { note: '按 32K/128K/256K 三档，最高 9.6/1.92/48。' }),
      model('doubao-seed-2.0-mini', 'Doubao Seed 2.0 Mini', 'CNY', rate(0.2, 0.04, 0, 2), { note: '三档最高 0.8/0.16/8。' }),
      model('doubao-seed-2.0-lite', 'Doubao Seed 2.0 Lite', 'CNY', rate(0.6, 0.12, 0, 3.6), { note: '三档最高 1.8/0.36/10.8。' })
    ]
  },
  {
    vendor: 'Kimi（月之暗面）',
    billing: 'CNY',
    models: [
      model('kimi-k3.1-pro', 'Kimi K3.1 Pro', 'CNY', rate(13, 1.3, 13, 68), { note: '缓存写入 5m/1h = 13/26；官网美元价 $2/$0.20/$10；Batch 为标准价 60%；1M 上下文不分档。', aliases: ['kimi-k3.1-pro'] }),
      model('kimi-k3.1-pro-highspeed', 'Kimi K3.1 Pro Highspeed', 'CNY', rate(26, 1.3, 26, 136), { note: '缓存写入 26/52；美元价 $4/$0.20/$20。' }),
      model('kimi-k3', 'Kimi K3', 'CNY', rate(20, 2, 20, 100), { note: '缓存写入 20/40。' }),
      model('kimi-k2.7-code', 'Kimi K2.7 Code', 'CNY', rate(6.5, 1.3, 0, 27)),
      model('kimi-k2.6', 'Kimi K2.6', 'CNY', rate(6.5, 1.1, 0, 27), { note: '缓存自动启用、默认 5 分钟 TTL。' })
    ]
  },
  {
    vendor: 'MiniMax',
    billing: 'CNY',
    models: [
      model('minimax-m3', 'MiniMax M3 (≤512K)', 'CNY', rate(2.1, 0.42, 0, 8.4), { note: '永久 5 折（原价 4.2/0.84/16.8）；>512K 整单 4.2/0.84/16.8；Priority 1.5 倍。' }),
      model('minimax-m3.1-flash', 'MiniMax M3.1 Flash', 'CNY', rate(1, 0.1, 0, 4))
    ]
  }
];

export function catalogEntryForRoute(route, catalog = pricingCatalog) {
  if (typeof route !== 'string') return null;
  const normalized = route.trim().replace(/^magpie\//i, '');
  if (!normalized) return null;
  const bare = normalized.split('/').pop().toLowerCase();
  for (const group of catalog) {
    for (const entry of group.models) {
      if (entry.aliases.some((alias) => alias.toLowerCase() === normalized.toLowerCase())) {
        return { ...entry, vendor: group.vendor };
      }
    }
  }
  for (const group of catalog) {
    for (const entry of group.models) {
      if (entry.model.toLowerCase() === bare || entry.aliases.some((alias) => alias.toLowerCase() === bare)) {
        return { ...entry, vendor: group.vendor };
      }
    }
  }
  return null;
}

export function catalogEntryToRoute(entry) {
  return {
    vendor: entry.vendor,
    label: entry.label,
    currency: entry.currency,
    peak: { ...entry.peak },
    offPeak: entry.offPeak ? { ...entry.offPeak } : null,
    peakRule: entry.peakRule,
    note: entry.note
  };
}