/**
 * Archive (trash) pane: month/day stream with server-side search + filters and
 * cursor pagination. Only the loaded batches live in the DOM, so a large
 * archive cannot blow up the page (design approved 2026-11-24).
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { CommanderStore } from './store'
import type { ArchiveMonthCount, ArchiveQuery, ArchiveSummary, TaskView } from './types'
import { archiveMonthBounds, canRestoreTask, formatBoardTime, groupArchiveByMonthDay, statusLabelKey } from './board'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** One batch of archive rows fetched per request (Host caps limit at 100). */
export const ARCHIVE_PAGE_SIZE = 60

 interface ArchivePaneProps {
  store: CommanderStore
  t: Translate
  workspaces: ReadonlyArray<{ id: string }>
  workspaceName: (workspaceId: string | undefined) => string
  /** Unfiltered trash count from the snapshot (tab badge), used for 「全量 N 条」. */
  allTotal: number
  onRestore: (task: TaskView) => Promise<boolean>
}

type Phase = 'loading' | 'ready' | 'error' | 'missing'
type StatusFilter = 'all' | 'archived' | 'cancelled'

const monthFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' })
const dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', weekday: 'short' })

function monthLabelOf(key: string): string {
  const [year, month] = key.split('-').map(Number)
  return monthFormatter.format(new Date(year ?? 0, (month ?? 1) - 1, 1))
}
function dayLabelOf(at: number): string {
  return dayFormatter.format(new Date(at))
}
function formatCount(value: number): string {
  return value.toLocaleString()
}

/** Month + day stream, filters, stats and restore for archived/cancelled tasks. */
export function ArchivePane({ store, t, workspaces, workspaceName, allTotal, onRestore }: ArchivePaneProps): ReactNode {
  const [query, setQuery] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const [status, setStatus] = React.useState<StatusFilter>('all')
  const [workspaceId, setWorkspaceId] = React.useState('all')
  const [month, setMonth] = React.useState('all')
  const [phase, setPhase] = React.useState<Phase>('loading')
  const [error, setError] = React.useState('')
  const [tasks, setTasks] = React.useState<TaskView[]>([])
  const [nextCursor, setNextCursor] = React.useState<string | number | null | undefined>(undefined)
  const [total, setTotal] = React.useState(0)
  const [summary, setSummary] = React.useState<ArchiveSummary | undefined>(undefined)
  const [months, setMonths] = React.useState<ArchiveMonthCount[]>([])
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [moreError, setMoreError] = React.useState('')
  const [restoring, setRestoring] = React.useState<ReadonlySet<string>>(new Set())
  const sequence = React.useRef(0)

  React.useEffect(() => {
    const timer = setTimeout(() => { setDebouncedQuery(query.trim()) }, 260)
    return () => { clearTimeout(timer) }
  }, [query])

  const queryOf = React.useCallback((cursor?: string | number | null): ArchiveQuery => {
    const bounds = month === 'all' ? {} : archiveMonthBounds(month)
    return {
      limit: ARCHIVE_PAGE_SIZE,
      ...(debouncedQuery === '' ? {} : { q: debouncedQuery }),
      ...(status === 'all' ? {} : { status }),
      ...(workspaceId === 'all' ? {} : { workspaceId }),
      ...bounds,
      ...(cursor === undefined || cursor === null ? {} : { cursor }),
    }
  }, [debouncedQuery, month, status, workspaceId])

  const loadFirstPage = React.useCallback(async (): Promise<void> => {
    const token = ++sequence.current
    setPhase('loading')
    setError('')
    setMoreError('')
    setTasks([])
    setNextCursor(undefined)
    setTotal(0)
    setSummary(undefined)
    const result = await store.loadArchive(queryOf())
    if (token !== sequence.current) return
    if (!result.ok) {
      const missing = result.failure.code === 'not_found' || result.failure.code === 'route_missing'
      setPhase(missing ? 'missing' : 'error')
      setError(result.failure.message)
      return
    }
    setTasks(result.data.tasks)
    setNextCursor(result.data.nextCursor ?? null)
    setTotal(result.data.total ?? result.data.tasks.length)
    setSummary(result.data.summary)
    setMonths(result.data.months ?? [])
    setPhase('ready')
  }, [queryOf, store])

  React.useEffect(() => { void loadFirstPage() }, [loadFirstPage])

  const loadMore = async (): Promise<void> => {
    if (loadingMore || nextCursor === undefined || nextCursor === null) return
    const token = sequence.current
    setLoadingMore(true)
    setMoreError('')
    const result = await store.loadArchive(queryOf(nextCursor))
    if (token !== sequence.current) {
      setLoadingMore(false)
      return
    }
    setLoadingMore(false)
    if (!result.ok) {
      setMoreError(result.failure.message)
      return
    }
    const page = result.data
    setTasks((current) => {
      const seen = new Set(current.map((row) => row.id))
      return [...current, ...page.tasks.filter((row) => !seen.has(row.id))]
    })
    setNextCursor(page.nextCursor ?? null)
    if (page.total !== undefined) setTotal(page.total)
    if (page.summary !== undefined) setSummary(page.summary)
    if (page.months !== undefined) setMonths(page.months)
  }

  const restore = async (task: TaskView): Promise<void> => {
    if (restoring.has(task.id)) return
    setRestoring((current) => new Set(current).add(task.id))
    const ok = await onRestore(task)
    setRestoring((current) => {
      const next = new Set(current)
      next.delete(task.id)
      return next
    })
    if (ok) await loadFirstPage()
  }

  const filterActive = query.trim() !== '' || status !== 'all' || workspaceId !== 'all' || month !== 'all'
  const monthBaseTotal = months.reduce((sum, row) => sum + row.count, 0)
  const groups = React.useMemo(() => groupArchiveByMonthDay(tasks), [tasks])
  const monthOptions = React.useMemo(() => {
    const rows = [...months]
    if (month !== 'all' && !rows.some((row) => row.key === month)) rows.push({ key: month, count: 0 })
    return rows.sort((a, b) => b.key.localeCompare(a.key))
  }, [month, months])
  const summaryValue = summary ?? { archivedCount: 0, cancelledCount: 0, last30dCount: 0 }
  const restoreAllowed = canRestoreTask

  const clearFilters = (): void => {
    setQuery('')
    setDebouncedQuery('')
    setStatus('all')
    setWorkspaceId('all')
    setMonth('all')
  }

  return (
    <div className="dshc-archive">
      <div className="dshc-archive-toolbar">
        <label className="dshc-archive-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            placeholder={t('board.trash.searchPlaceholder')}
            aria-label={t('board.trash.searchPlaceholder')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </label>
        <div className="dshc-archive-chips" role="group" aria-label={t('board.trash.filterLabel')}>
          {(['all', 'archived', 'cancelled'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="dshc-archive-chip"
              data-active={status === value}
              onClick={() => { setStatus(value) }}
            >
              {t(`board.trash.status.${value}`)}
            </button>
          ))}
        </div>
        <label className="dshc-archive-select">
          <span>{t('board.trash.workspace')}</span>
          <select value={workspaceId} aria-label={t('board.trash.workspace')} onChange={(event) => { setWorkspaceId(event.target.value) }}>
            <option value="all">{t('board.trash.workspaceAll')}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspaceName(workspace.id)}</option>
            ))}
          </select>
        </label>
        <label className="dshc-archive-select">
          <span>{t('board.trash.month')}</span>
          <select value={month} aria-label={t('board.trash.month')} onChange={(event) => { setMonth(event.target.value) }}>
            <option value="all">{t('board.trash.monthAll')}</option>
            {monthOptions.map((row) => (
              <option key={row.key} value={row.key}>{monthLabelOf(row.key)}</option>
            ))}
          </select>
        </label>
        {filterActive ? (
          <button type="button" className="dshc-archive-clear" onClick={clearFilters}>{t('board.trash.clearFilters')}</button>
        ) : null}
        <span className="dshc-archive-hint">
          {filterActive
            ? t('board.trash.loadedHint', { total, size: ARCHIVE_PAGE_SIZE })
            : t('board.trash.loadedHintAll', { total, size: ARCHIVE_PAGE_SIZE })}
        </span>
      </div>

      <div className="dshc-archive-stats">
        <div className="dshc-archive-stat" data-active={filterActive}>
          <span>{filterActive ? t('board.trash.stats.filtered') : t('board.trash.stats.total')}</span>
          <b>{formatCount(total)}</b>
          <em>{filterActive ? t('board.trash.stats.allTotal', { n: allTotal }) : t('board.trash.domCount', { loaded: tasks.length, total })}</em>
        </div>
        <div className="dshc-archive-stat">
          <span>{t('board.trash.stats.archived')}</span>
          <b>{formatCount(summaryValue.archivedCount)}</b>
          <em>{t('board.trash.stats.archivedHint')}</em>
        </div>
        <div className="dshc-archive-stat">
          <span>{t('board.trash.stats.cancelled')}</span>
          <b>{formatCount(summaryValue.cancelledCount)}</b>
          <em>{t('board.trash.stats.cancelledHint')}</em>
        </div>
        <div className="dshc-archive-stat">
          <span>{t('board.trash.stats.recent')}</span>
          <b>{formatCount(summaryValue.last30dCount)}</b>
          <em>{t('board.trash.stats.recentHint')}</em>
        </div>
      </div>

      <div className="dshc-archive-body">
        <nav className="dshc-archive-months" aria-label={t('board.trash.month')}>
          <h2>{t('board.trash.monthNav')}</h2>
          <button
            type="button"
            className="dshc-archive-month"
            data-active={month === 'all'}
            onClick={() => { setMonth('all') }}
          >
            <span>{t('board.trash.monthAll')}</span><b>{formatCount(monthBaseTotal)}</b>
          </button>
          {monthOptions.map((row) => (
            <button
              key={row.key}
              type="button"
              className="dshc-archive-month"
              data-active={month === row.key}
              onClick={() => { setMonth(row.key) }}
            >
              <span>{monthLabelOf(row.key)}</span><b>{formatCount(row.count)}</b>
            </button>
          ))}
          <p className="dshc-archive-month-note">{t('board.trash.monthNote', { size: ARCHIVE_PAGE_SIZE })}</p>
        </nav>

        <div className="dshc-archive-stream">
          {phase === 'loading' ? <div className="dshc-board-state">{t('board.loading')}</div> : null}
          {phase === 'missing' ? <div className="dshc-board-state">{t('board.trash.unavailable')}</div> : null}
          {phase === 'error' ? (
            <div className="dshc-board-state">
              {`${t('board.error.load')}：${error}`}
              <button type="button" className="dshc-msg-toggle" onClick={() => { void loadFirstPage() }}>{t('board.retry')}</button>
            </div>
          ) : null}
          {phase === 'ready' && tasks.length === 0 ? (
            <div className="dshc-board-state">{filterActive ? t('board.trash.noMatch') : t('board.trash.empty')}</div>
          ) : null}
          {phase === 'ready' && tasks.length > 0 ? groups.map((monthGroup) => {
            const monthCount = months.find((row) => row.key === monthGroup.key)?.count
            return (
              <section key={monthGroup.key} className="dshc-archive-month-group">
                <header className="dshc-archive-month-head">
                  <h2>{monthLabelOf(monthGroup.key)}</h2>
                  <span>{t('board.trash.dayCount', { n: monthCount ?? monthGroup.days.reduce((sum, day) => sum + day.tasks.length, 0) })}</span>
                </header>
                {monthGroup.days.map((day) => (
                  <section key={day.key} className="dshc-archive-day">
                    <header className="dshc-archive-day-head">
                      <h3>{dayLabelOf(day.at)}</h3>
                      <span>{t('board.trash.dayCount', { n: day.tasks.length })}</span>
                    </header>
                    <div className="dshc-archive-grid">
                      {day.tasks.map((task) => (
                        <article key={task.id} className="dshc-archive-card" data-status={task.status}>
                          <div className="dshc-archive-card-top">
                            <span className="dshc-archive-card-type">{t(statusLabelKey(task.status))}</span>
                            <time>{formatBoardTime(task.updatedAt)}</time>
                          </div>
                          <h4>{task.title ?? task.id}</h4>
                          <div className="dshc-archive-card-foot">
                            <span>{workspaceName(task.workspaceId) || task.workspaceId}</span>
                            <span>{t('board.round.badge', { round: task.round ?? 1 })}</span>
                            {restoreAllowed(task) ? (
                              <button
                                type="button"
                                className="dshc-archive-restore"
                                disabled={restoring.has(task.id)}
                                onClick={() => { void restore(task) }}
                              >
                                {t('board.action.restore')}
                              </button>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </section>
            )
          }) : null}

          {phase === 'ready' && tasks.length > 0 ? (
            <div className="dshc-archive-load">
              <span>{t('board.trash.domCount', { loaded: tasks.length, total })}</span>
              <div className="dshc-archive-load-bar" aria-hidden="true">
                <i style={{ width: `${String(total === 0 ? 0 : Math.min(100, Math.round((tasks.length / total) * 100)))}%` }} />
              </div>
              <button
                type="button"
                className="dshc-button"
                data-variant="secondary"
                disabled={loadingMore || nextCursor === undefined || nextCursor === null}
                onClick={() => { void loadMore() }}
              >
                {loadingMore ? t('board.loading') : nextCursor === undefined || nextCursor === null ? t('board.trash.allLoaded') : t('board.trash.loadMore', { n: ARCHIVE_PAGE_SIZE })}
              </button>
              {moreError === '' ? null : <div className="dshc-archive-load-error">{`${t('board.error.load')}：${moreError}`}</div>}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
