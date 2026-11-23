export interface UsageEntry {
  id: string
  source: 'harness' | 'leaderteam'
  role: string
  route: string
  effort: string | null
  at: string | null
  sessionId?: string
  teamId?: string
  attempts: number
  ok: boolean | null
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  } | null
  complete: boolean | null
}

export interface UsageSnapshot {
  entries: UsageEntry[]
  coverage: {
    sessions: number
    pendingSessions: number
    ledgerFiles: number
    partial: boolean
    warnings: string[]
  }
}
