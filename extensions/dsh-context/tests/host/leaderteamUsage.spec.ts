import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessEntriesOf, ledgerEntryOf, readLedgerUsage } from '../../src/host/leaderteamUsage'

const row = { role: 'gate', route: 'zcode/GLM-5.3', effort: 'high', at: '2026-11-08T01:00:00Z', ok: false, attempts: 3, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 80, reasoningTokens: 4 } }
async function fixture(text: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'context-usage-'))
  await mkdir(join(home, 'leaderteam/teams/t1'), { recursive: true })
  await writeFile(join(home, 'leaderteam/teams/t1/usage.jsonl'), text)
  return home
}
describe('LeaderTeam reported usage', () => {
  it('keeps retry totals, failure and physical-line identity', () => {
    const entry = ledgerEntryOf(row, 't1', 3)!
    expect(entry.usage?.totalTokens).toBe(110)
    expect(entry.attempts).toBe(3)
    expect(entry.ok).toBe(false)
    expect(entry.complete).toBe(null)
    expect(entry.id).not.toBe(ledgerEntryOf(row, 't1', 4)!.id)
  })
  it('keeps missing or invalid usage unknown', () => {
    expect(ledgerEntryOf({ ...row, usage: null }, 't1', 1)!.usage).toBe(null)
    expect(ledgerEntryOf({ ...row, usage: { inputTokens: -1, totalTokens: Infinity } }, 't1', 1)!.usage).toBe(null)
    expect(ledgerEntryOf({ ...row, usage: { outputTokens: 2 } }, 't1', 1)!.usage).toEqual({ outputTokens: 2 })
    expect(ledgerEntryOf({ ...row, role: 'intruder' }, 't1', 1)).toBe(null)
  })
  it('preserves a missing total rather than deriving from incompatible adapter categories', () => {
    expect(ledgerEntryOf({ ...row, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, reasoningTokens: 3 } }, 't1', 1)!.usage?.totalTokens).toBeUndefined()
  })
  it('deduplicates own session identity and never imports family rollups', () => {
    const cost = { magpie: { 'zcode/GLM-5.3': { peak: { uncached: 10, cacheRead: 20, cacheWrite: 2, output: 3 } } } }
    const result = harnessEntriesOf([{ header: { id: 'p' } }, { header: { id: 'p' } }, { header: { id: 'c' } }], {
      getSession: () => undefined, snapshotOf: () => undefined,
      cachedOf: () => ({ values: { contextTimeline: { cost, familyCost: { invalid: 99999 }, reasoningEffort: 'max' } } }),
    })
    expect(result.sessions).toBe(2)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.reduce((sum, x) => sum + (x.usage?.totalTokens ?? 0), 0)).toBe(70)
    expect(result.entries.every(x => x.effort === null)).toBe(true)
    expect(result.entries[0].usage?.inputTokens).toBe(10)
  })
  it('reports unavailable projections as pending rather than zero', () => {
    const result = harnessEntriesOf([{ header: { id: 'p' } }], { getSession: () => undefined, snapshotOf: () => undefined, cachedOf: () => undefined })
    expect(result.entries).toEqual([])
    expect(result.pendingSessions).toBe(1)
  })
  it('reads lines with stable ids and flags malformed lines', async () => {
    const home = await fixture(JSON.stringify(row) + '\ninvalid\n' + JSON.stringify({ ...row, usage: null }))
    const result = await readLedgerUsage(home)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1].id).toContain(':3')
    expect(result.entries[1].usage).toBe(null)
    expect(result.partial).toBe(true)
    expect(result.warnings.join(' ')).not.toContain(home)
  })
  it('preserves incomplete trailing line for the next poll without counting it', async () => {
    const home = await fixture(JSON.stringify(row) + '\n{"role":')
    const result = await readLedgerUsage(home)
    expect(result.entries).toHaveLength(1)
    expect(result.partial).toBe(true)
  })
  it('caps entry count and oversized lines visibly', async () => {
    const home = await fixture(JSON.stringify(row) + '\n' + JSON.stringify(row) + '\n')
    const result = await readLedgerUsage(home, { maxTeams: 4, maxEntries: 1, maxLineBytes: 65536, maxFileBytes: 10000 })
    expect(result.entries).toHaveLength(1)
    expect(result.partial).toBe(true)
    const oversized = await readLedgerUsage(home, { maxTeams: 4, maxEntries: 10, maxLineBytes: 10, maxFileBytes: 10000 })
    expect(oversized.entries).toEqual([])
    expect(oversized.partial).toBe(true)
  })
  it('rejects ledger links outside the current Harness home', async () => {
    const home = await fixture(JSON.stringify(row))
    const outside = await mkdtemp(join(tmpdir(), 'context-outside-'))
    await mkdir(join(outside, 't2'))
    await writeFile(join(outside, 't2/usage.jsonl'), JSON.stringify(row))
    await symlink(join(outside, 't2'), join(home, 'leaderteam/teams/t2'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await readLedgerUsage(home)
    expect(result.entries).toHaveLength(1)
    expect(result.partial).toBe(true)
  })
  it('does not fall back to another home', async () => {
    const result = await readLedgerUsage(undefined)
    expect(result.entries).toEqual([])
    expect(result.partial).toBe(true)
  })
  it('rejects a ledger root redirected elsewhere within the same home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'context-usage-root-'))
    await mkdir(join(home, 'other/teams/t1'), { recursive: true })
    await writeFile(join(home, 'other/teams/t1/usage.jsonl'), JSON.stringify(row))
    await symlink(join(home, 'other'), join(home, 'leaderteam'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await readLedgerUsage(home)
    expect(result.entries).toEqual([])
    expect(result.partial).toBe(true)
  })
  it('does not turn an invalid output into a zero total', () => {
    const result = harnessEntriesOf([{ header: { id: 'p' } }], { getSession: () => undefined, snapshotOf: () => undefined, cachedOf: () => ({ values: { contextTimeline: { cost: { magpie: { model: { peak: { uncached: 10, output: null } } } } } } }) })
    expect(result.entries[0].usage?.outputTokens).toBeUndefined()
    expect(result.entries[0].usage?.totalTokens).toBeUndefined()
  })
})
