import type { UsageEntry, UsageSnapshot } from '../shared/leaderteamUsage'

export interface UsageGroup {
  route: string
  effort: string | null
  records: number
  missing: number
  input: number | null
  output: number | null
  total: number | null
  cache: number | null
  cacheWrite: number | null
  reasoning: number | null
}
export function aggregateUsage(entries: readonly UsageEntry[], filter: { source?: string; role?: string; model?: string } = {}): UsageGroup[] {
  const seen = new Set<string>(), groups = new Map<string, UsageGroup>()
  const n = (value: number | undefined): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const add = (a: number | null, b: number | null): number | null => b === null ? a : (a ?? 0) + b
  for (const entry of entries) {
    if (filter.source && entry.source !== filter.source || filter.role && entry.role !== filter.role || filter.model && entry.route !== filter.model) continue
    const identity = `${entry.source}:${entry.id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const key = JSON.stringify([entry.route, entry.effort])
    const group = groups.get(key) ?? { route: entry.route, effort: entry.effort, records: 0, missing: 0, input: null, output: null, total: null, cache: null, cacheWrite: null, reasoning: null }
    const input = n(entry.usage?.inputTokens), output = n(entry.usage?.outputTokens)
    const total = n(entry.usage?.totalTokens)
    group.records++
    if (total === null) group.missing++
    group.input = add(group.input, input); group.output = add(group.output, output); group.total = add(group.total, total)
    group.cache = add(group.cache, n(entry.usage?.cacheReadTokens)); group.reasoning = add(group.reasoning, n(entry.usage?.reasoningTokens))
    group.cacheWrite = add(group.cacheWrite, n(entry.usage?.cacheWriteTokens))
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.route.localeCompare(b.route))
}
export async function fetchReportedUsage(signal: AbortSignal): Promise<UsageSnapshot> {
  const response = await fetch('api/dsh-context/leaderteam-usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal })
  const result = await response.json() as { ok?: boolean; value?: UsageSnapshot }
  if (!response.ok || result.ok !== true || !result.value || !Array.isArray(result.value.entries) || !result.value.coverage) throw Error('Usage snapshot unavailable')
  return result.value
}
