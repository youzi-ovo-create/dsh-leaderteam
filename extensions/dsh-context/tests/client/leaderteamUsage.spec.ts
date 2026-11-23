import { describe, it, expect } from 'vitest'
import { aggregateUsage } from '../../src/client/leaderteamUsage'
import type { UsageEntry } from '../../src/shared/leaderteamUsage'
const entry = (patch: Partial<UsageEntry> = {}): UsageEntry => ({ id: '1', source: 'leaderteam', role: 'gate', route: 'zcode/GLM-5.3', effort: 'high', at: null, attempts: 3, ok: true, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 80, reasoningTokens: 5 }, complete: null, ...patch })
describe('Reported usage totals', () => {
  it('deduplicates stable source ids without multiplying retries or breakdowns', () => {
    const [group] = aggregateUsage([entry(), entry()])
    expect(group.records).toBe(1)
    expect(group.total).toBe(110)
    expect(group.cache).toBe(80)
    expect(group.reasoning).toBe(5)
  })
  it('keeps same call identifiers from different source rows and sources', () => {
    const groups = aggregateUsage([entry(), entry({ id: '2' }), entry({ source: 'harness' })])
    expect(groups[0].total).toBe(330)
  })
  it('keeps missing totals unknown alongside reported subtotals', () => {
    const [group] = aggregateUsage([entry(), entry({ id: '2', usage: null })])
    expect(group.total).toBe(110)
    expect(group.missing).toBe(1)
    expect(aggregateUsage([entry({ usage: null })])[0].total).toBe(null)
  })
  it('separates history with unknown effort from actual role effort', () => {
    const groups = aggregateUsage([entry(), entry({ id: '2', effort: null })])
    expect(groups).toHaveLength(2)
    expect(groups.find(group => group.effort === null)?.total).toBe(110)
  })
  it('filters model, source and role before grouping', () => {
    expect(aggregateUsage([entry(), entry({ id: '2', role: 'arbiter' })], { role: 'arbiter', model: 'zcode/GLM-5.3', source: 'leaderteam' })[0].records).toBe(1)
    expect(aggregateUsage([entry()], { source: 'harness' })).toEqual([])
  })
  it('does not derive total from an output-only record', () => {
    const [group] = aggregateUsage([entry({ usage: { outputTokens: 3, cacheReadTokens: 5 } })])
    expect(group.input).toBe(null)
    expect(group.total).toBe(null)
  })
})
