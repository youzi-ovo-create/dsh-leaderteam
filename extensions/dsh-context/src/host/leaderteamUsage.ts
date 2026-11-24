import type { Context } from '@deepseek-ai/cordis'
import { createReadStream } from 'node:fs'
import { lstat, realpath, opendir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { asRecord } from './record'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import type { UsageEntry, UsageSnapshot } from '../shared/leaderteamUsage'

export const LEADERTEAM_USAGE_ROUTE = '/api/dsh-context/leaderteam-usage'

const LEDGER_ROLES = new Set(['gate', 'discussA', 'discussB', 'arbiter'])
const DEFAULT_LIMITS = { maxTeams: 4096, maxEntries: 100000, maxLineBytes: 64 * 1024, maxFileBytes: 16 * 1024 * 1024 }

interface ListRecordLike {
  header?: unknown
}

interface QueryFaceLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

interface SnapshotBlockLike {
  values?: unknown
}

interface ProjectionsFaceLike {
  snapshot(session: unknown, keys?: ReadonlySet<string>): SnapshotBlockLike | undefined
}

interface CacheFaceLike {
  cachedSnapshot(header: unknown, keys?: ReadonlySet<string>): SnapshotBlockLike | undefined
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

function encodedId(prefix: 'harness' | 'leaderteam', parts: readonly string[]): string {
  return [prefix, ...parts].map(part => encodeURIComponent(part)).join(':')
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function isInside(parent: string, child: string): boolean {
  const bound = resolve(parent)
  const target = resolve(child)
  const prefix = bound.endsWith(sep) ? bound : bound + sep
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix)
}

function tokenOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function periodHas(periods: Record<string, unknown>, key: string): boolean {
  return [periods.peak, periods.off].some(period => tokenOf(asRecord(period)?.[key]) !== undefined)
}

export function harnessEntriesOf(records: readonly unknown[], services: {
  getSession(id: string): unknown
  snapshotOf(session: unknown): SnapshotBlockLike | undefined
  cachedOf(header: unknown): SnapshotBlockLike | undefined
}): { entries: UsageEntry[]; sessions: number; pendingSessions: number } {
  const entries: UsageEntry[] = []
  const seen = new Set<string>()
  const sessionIds = new Set<string>()
  const pending = new Set<string>()
  for (const record of records) {
    const header = asRecord((record as ListRecordLike | null)?.header)
    const sessionId = typeof header?.id === 'string' && header.id !== '' ? header.id : null
    if (sessionId === null) continue
    sessionIds.add(sessionId)
    pending.add(sessionId)
    let block: SnapshotBlockLike | undefined
    try {
      const session = services.getSession(sessionId)
      block = session !== undefined ? services.snapshotOf(session) : services.cachedOf(header)
    } catch {
      continue
    }
    const timeline = asRecord(asRecord(block?.values)?.contextTimeline)
    const cost = asRecord(timeline?.cost)
    if (cost === null) continue
    for (const [provider, modelsRecord] of Object.entries(cost)) {
      const models = asRecord(modelsRecord)
      if (models === null || provider === '') continue
      for (const [model, periodsRecord] of Object.entries(models)) {
        if (model === '') continue
        const periods = asRecord(periodsRecord)
        if (periods === null) continue
        const totals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        let known = false
        for (const period of [periods.peak, periods.off]) {
          const bucket = asRecord(period)
          if (bucket === null) continue
          for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
            const value = tokenOf(bucket[key])
            if (value !== undefined) {
              totals[key] += value
              known = true
            }
          }
        }
        if (!known) continue
        const key = `${sessionId}\0${provider}\0${model}`
        if (seen.has(key)) continue
        seen.add(key)
        pending.delete(sessionId)
        const input = totals.uncached + totals.cacheRead + totals.cacheWrite
        const hasInput = periodHas(periods, 'uncached')
        const hasOutput = periodHas(periods, 'output')
        const route = provider === 'magpie' || model.includes('/') ? model : `${provider}/${model}`
        entries.push({
          id: encodedId('harness', [sessionId, provider, model]),
          source: 'harness',
          role: 'session',
          route,
          effort: null,
          at: null,
          sessionId,
          attempts: 1,
          ok: true,
          usage: {
            ...(hasInput ? { inputTokens: totals.uncached } : {}),
            ...(periodHas(periods, 'cacheRead') ? { cacheReadTokens: totals.cacheRead } : {}),
            ...(periodHas(periods, 'cacheWrite') ? { cacheWriteTokens: totals.cacheWrite } : {}),
            ...(periodHas(periods, 'output') ? { outputTokens: totals.output } : {}),
            ...(hasInput && hasOutput ? { totalTokens: input + totals.output } : {}),
          },
          complete: null,
        })
      }
    }
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return { entries, sessions: sessionIds.size, pendingSessions: pending.size }
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

export function ledgerEntryOf(value: unknown, teamId: string, line: number): UsageEntry | null {
  const row = asRecord(value)
  if (row === null || !LEDGER_ROLES.has(String(row.role)) || typeof row.route !== 'string' || row.route.length === 0 || row.route.length > 256) return null
  const raw = asRecord(row.usage)
  let usage: UsageEntry['usage'] = null
  if (raw !== null) {
    const picked: NonNullable<UsageEntry['usage']> = {}
    for (const key of USAGE_KEYS) {
      const n = tokenOf(raw[key])
      if (n !== undefined) picked[key] = n
    }
    if (Object.keys(picked).length > 0) usage = picked
  }
  return {
    id: encodedId('leaderteam', [teamId, String(line)]), source: 'leaderteam', role: String(row.role), route: row.route,
    effort: typeof row.effort === 'string' && row.effort.length <= 32 ? row.effort : null,
    at: typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : null,
    teamId, attempts: typeof row.attempts === 'number' && Number.isInteger(row.attempts) && row.attempts > 0 ? row.attempts : 1,
    ok: typeof row.ok === 'boolean' ? row.ok : null, usage, complete: null,
  }
}

export async function readLedgerUsage(home: string | undefined, limits = DEFAULT_LIMITS): Promise<{ entries: UsageEntry[]; ledgerFiles: number; partial: boolean; warnings: string[] }> {
  const entries: UsageEntry[] = []
  const result = { entries, ledgerFiles: 0, partial: false, warnings: [] as string[] }
  let skipped = 0, totalBytes = 0
  const warn = (message: string): void => { result.partial = true; if (!result.warnings.includes(message)) result.warnings.push(message) }
  if (!home) { warn('Harness home is unavailable'); return result }
  let homeRoot: string, teamsRoot: string
  try {
    homeRoot = await realpath(home)
    const storage = join(homeRoot, 'leaderteam'), teams = join(storage, 'teams')
    if ((await lstat(storage)).isSymbolicLink() || (await lstat(teams)).isSymbolicLink() || !samePath(await realpath(storage), storage) || !samePath(await realpath(teams), teams)) { warn('Linked ledger root skipped'); return result }
    teamsRoot = await realpath(teams)
    if (!isInside(homeRoot, teamsRoot)) { warn('Ledger location is outside Harness home'); return result }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('Ledger directory could not be read')
    return result
  }
  let teamCount = 0
  try {
    const directory = await opendir(teamsRoot)
    for await (const dirent of directory) {
      if (++teamCount > limits.maxTeams) { warn('Team limit reached'); break }
      if (dirent.isSymbolicLink()) { warn('Linked team directory skipped'); continue }
      if (!dirent.isDirectory()) continue
      const file = join(teamsRoot, dirent.name, 'usage.jsonl')
      try {
        const teamPath = await realpath(join(teamsRoot, dirent.name))
        if (!isInside(teamsRoot, teamPath)) { warn('Team path outside ledger root skipped'); continue }
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(file), file)) { warn('Linked ledger file skipped'); continue }
        result.ledgerFiles++
        let pending = '', dropping = false, line = 0, fileBytes = 0, capped = false
        const accept = (text: string): void => {
          line++
          if (!text.trim()) return
          try {
            const row = ledgerEntryOf(JSON.parse(text), dirent.name, line)
            if (row !== null) entries.push(row)
            else skipped++
          } catch { skipped++ }
        }
        for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
          const text = String(chunk)
          fileBytes += Buffer.byteLength(text); totalBytes += Buffer.byteLength(text)
          if (fileBytes > limits.maxFileBytes || totalBytes > 64 * 1024 * 1024) { warn('Ledger byte limit reached'); capped = true; break }
          let start = 0
          for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
            const part = text.slice(start, end)
            if (dropping || Buffer.byteLength(pending) + Buffer.byteLength(part) > limits.maxLineBytes) { line++; skipped++ }
            else accept(pending + part)
            pending = ''; dropping = false; start = end + 1
            if (entries.length >= limits.maxEntries) { warn('Ledger entry limit reached'); capped = true; break }
          }
          if (entries.length >= limits.maxEntries) break
          const rest = text.slice(start)
          if (dropping || Buffer.byteLength(pending) + Buffer.byteLength(rest) > limits.maxLineBytes) { pending = ''; dropping = true }
          else pending += rest
        }
        if (!capped && (pending || dropping)) { if (dropping) skipped++; else accept(pending) }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('Ledger file could not be read') }
      if (entries.length >= limits.maxEntries || totalBytes > 64 * 1024 * 1024) break
    }
  } catch { warn('Ledger directory could not be enumerated') }
  if (skipped > 0) warn(`${skipped} invalid or oversized ledger lines skipped`)
  return result
}

export function watchLeaderteamUsageRoute(ctx: Context): () => void {
  const fiber = ctx.inject(['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'], c => {
    let inFlight: Promise<UsageSnapshot> | undefined
    const load = async (): Promise<UsageSnapshot> => {
      const query = c.get('sessionQuery') as QueryFaceLike
      const sessions = c.get('sessions') as { get(id: string): unknown }
      const projections = c.get('sessionProjections') as ProjectionsFaceLike
      const cache = c.get('sessionProjectionCache') as CacheFaceLike
      const keys = new Set(['contextTimeline'])
      const records = await query.listSessions()
      const own = harnessEntriesOf(Array.isArray(records) ? records.slice(0, 100000) : [], {
        getSession: id => sessions.get(id), snapshotOf: session => projections.snapshot(session, keys), cachedOf: header => cache.cachedSnapshot(header, keys),
      })
      const profileHome = (c.get('profileContext') as { home?: string } | undefined)?.home
      const defaultHome = process.env.DSH_HOME ?? profileHome ?? (process.env.HOME ? join(process.env.HOME, '.dsh') : undefined)
      const ledger = await readLedgerUsage(defaultHome)
      const capped = Array.isArray(records) && records.length > 100000
      return { entries: [...own.entries, ...ledger.entries], coverage: {
        sessions: own.sessions, pendingSessions: own.pendingSessions, ledgerFiles: ledger.ledgerFiles,
        partial: ledger.partial || capped, warnings: [...ledger.warnings, ...(capped ? ['Session limit reached'] : [])],
      } }
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace, LEADERTEAM_USAGE_ROUTE, async request => {
      try {
        const body = asRecord(await request.json())
        if (body === null || Object.keys(body).length !== 0) return failure('dsh-context/bad-request', 'Expected an empty JSON object')
      } catch { return failure('dsh-context/bad-request', 'Expected an empty JSON object') }
      try {
        inFlight ??= load().finally(() => { inFlight = undefined })
        return reply({ ok: true, value: await inFlight })
      } catch { return failure('gateway/internal', 'Usage snapshot could not be read') }
    }, 'dsh-context: reported usage route')
  })
  return () => { void (fiber as { dispose?: () => unknown } | undefined)?.dispose?.() }
}
