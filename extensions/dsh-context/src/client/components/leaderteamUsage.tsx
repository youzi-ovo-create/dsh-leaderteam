import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { aggregateUsage, fetchReportedUsage } from '../leaderteamUsage'
import type { UsageSnapshot } from '../../shared/leaderteamUsage'
import '../leaderteamUsage.css'

export function LeaderteamUsage({ zh }: { zh: boolean }): ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState(false), [updated, setUpdated] = useState<number | null>(null)
  const [revision, setRevision] = useState(0), [source, setSource] = useState(''), [role, setRole] = useState(''), [model, setModel] = useState('')
  const label = (cn: string, en: string): string => zh ? cn : en
  useEffect(() => {
    let alive = true, controller: AbortController | undefined, busy = false
    const load = async (): Promise<void> => {
      if (busy) return
      busy = true; controller = new AbortController()
      try {
        const next = await fetchReportedUsage(controller.signal)
        if (alive) { setSnapshot(next); setError(false); setUpdated(Date.now()) }
      } catch { if (alive) setError(true) }
      finally { busy = false }
    }
    void load()
    const timer = setInterval(() => { void load() }, 30000)
    return () => { alive = false; clearInterval(timer); controller?.abort() }
  }, [revision])
  const entries = snapshot?.entries ?? []
  const groups = useMemo(() => aggregateUsage(entries, { source, role, model }), [snapshot, source, role, model])
  const models = [...new Set(entries.map(entry => entry.route))].sort()
  const known = groups.some(row => row.total !== null)
  const total = groups.reduce((sum, row) => sum + (row.total ?? 0), 0)
  const missing = groups.reduce((sum, row) => sum + row.missing, 0)
  const number = (value: number | null): string => value === null ? label('未知', 'Unknown') : value.toLocaleString(zh ? 'zh-CN' : 'en-US')
  return <section className="lc-card lc-lt-usage" aria-label={label('模型累计实报用量', 'Reported usage by model')}>
    <div className="lc-lt-usage-head">
      <div><h3>{label('模型累计实报用量', 'Reported usage by model')}</h3><p>{label('当前 Harness 环境 · 全部会话与团队辅助调用 · 累计值不随上方日期筛选', 'This Harness environment · All sessions and team roles · Lifetime totals, independent of the date filter above')}</p></div>
      <button type="button" className="lc-gran-btn" onClick={() => setRevision(value => value + 1)}>{label('刷新', 'Refresh')}</button>
    </div>
    <div className="lc-lt-usage-total"><strong>{known ? number(total) : '—'}</strong><span>{label('已实报 token', 'reported tokens')}</span></div>
    <div className="lc-lt-usage-filters">
      <label>{label('模型', 'Model')}<select aria-label={label('用量模型', 'Usage model')} value={model} onChange={event => setModel(event.target.value)}><option value="">{label('全部模型', 'All models')}</option>{models.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>{label('来源', 'Source')}<select aria-label={label('用量来源', 'Usage source')} value={source} onChange={event => setSource(event.target.value)}><option value="">{label('全部来源', 'All sources')}</option><option value="harness">{label('领队与执行成员', 'Leaders and members')}</option><option value="leaderteam">{label('团队辅助角色', 'Team auxiliary roles')}</option></select></label>
      <label>{label('角色', 'Role')}<select aria-label={label('用量角色', 'Usage role')} value={role} onChange={event => setRole(event.target.value)}>{[['', label('全部角色', 'All roles')], ['session', label('领队／成员', 'Leader / member')], ['gate', label('安全门', 'Safety gate')], ['discussA', label('讨论 A', 'Reviewer A')], ['discussB', label('讨论 B', 'Reviewer B')], ['arbiter', label('裁断', 'Arbiter')]].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    </div>
    {error && <div role="alert" className="lc-lt-usage-status">{label('读取失败；下方保留上次结果，请刷新重试。', 'Refresh failed. Previous results are retained; retry with Refresh.')}</div>}
    {snapshot === null ? <p>{label(error ? '暂无可用数据' : '正在读取用量…', error ? 'No data available' : 'Loading usage…')}</p> : <>
      <div role="table" aria-label={label('按模型与档位汇总', 'Usage by model and effort')}>
        <div role="row" className="lc-lt-usage-row lc-lt-usage-columns"><span role="columnheader">{label('模型／档位', 'Model / effort')}</span><span role="columnheader">{label('非缓存输入', 'Uncached input')}</span><span role="columnheader">{label('输出', 'Output')}</span><span role="columnheader">{label('总计', 'Total')}</span></div>
        {groups.map(row => <div role="row" className="lc-lt-usage-row" key={JSON.stringify([row.route, row.effort])}>
          <div role="cell" className="lc-lt-usage-model"><b>{row.route}</b><span>{row.effort ?? label('档位未知', 'Effort unknown')} · {row.records} {label('条记录', 'records')}{row.missing > 0 ? ` · ${row.missing} ${label('条未报总量', 'without totals')}` : ''}</span><small>{label('缓存读／写', 'Cache read / write')} {number(row.cache)} / {number(row.cacheWrite)} · {label('推理', 'Reasoning')} {number(row.reasoning)}</small></div>
          <span role="cell">{number(row.input)}</span><span role="cell">{number(row.output)}</span><strong role="cell">{number(row.total)}</strong>
        </div>)}
      </div>
      {groups.length === 0 && <p>{label('当前筛选下没有用量记录', 'No usage records match these filters')}</p>}
      <p className="lc-lt-usage-status">{snapshot.coverage.sessions} {label('个会话', 'sessions')} · {snapshot.coverage.ledgerFiles} {label('个团队账本', 'team ledgers')} · {snapshot.coverage.pendingSessions} {label('个会话计量待载入或未报告', 'sessions pending or unmetered')} · {missing} {label('条记录未报告总量', 'records without totals')}{snapshot.coverage.partial ? ` · ${label('读取不完整', 'Partial read')}` : ''}</p>
      <p className="lc-lt-usage-status">{label('未知值不计为零。会话总计由非缓存输入、缓存读写和输出相加；辅助角色使用上游实报总计。推理已包含在输出中；重试按实报合计。历史会话未保存档位时显示未知。', 'Unknown values are not zero. Session totals sum uncached input, cache read/write and output; auxiliary roles use reported totals. Reasoning is included in output; retries use reported sums. Unrecorded historical effort stays unknown.')}</p>
      {updated !== null && <small>{label(error ? '上次成功读取：' : '更新于：', error ? 'Last successful refresh: ' : 'Updated: ')}{new Date(updated).toLocaleTimeString()}</small>}
    </>}
  </section>
}
