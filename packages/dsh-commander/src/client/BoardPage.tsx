/**
 * M2 board page registered into the `main` keyed slot as `commander-board`
 * (docs/architecture/m2m3-contract-patch.md §2).
 *
 * Five columns render the snapshot `tasks`; the trash tab lists
 * `GET /commander/archive`. Dragging a card PATCHes
 * `/commander/board/tasks/:id` through the store (optimistic + rollback); the
 * drawer reads `GET /commander/tasks/:id`. No Host code, no direct Remote.
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { CommanderStore, CommanderView } from './store'
import type { ReportMaterialView, TaskAcceptanceView, TaskDetailView, TaskDispatchDetailView, TaskSessionLinkView, TaskView } from './types'
import {
  BOARD_COLUMNS, BOARD_PRIORITIES, TASK_STAGES, acceptanceSummary, buildBoardPatch, buildTaskRounds, canArchiveTask,
  BOARD_COLUMN_FR_STORAGE_KEY, BOARD_COLUMN_MIN_PX, DEFAULT_BOARD_COLUMN_FR, canCancelTask, dependencyHighlightChain, downstreamCounts,
  formatBoardTime, formatClockTime, groupBoardTasks, hasPendingDispatch, normalizeBoardColumnFr,
  archiveCount, priorityLabelKey, resizeBoardColumnFr, shouldCollapseSummary, statusLabelKey, taskStage, taskStageBlocked, taskTerminal, waitingFor,
} from './board'
import type { TaskRoundView } from './board'
import { candidateProbability, capabilitySummary, capabilityTotal, formatPercent, normalizeProbability } from './dispatch'
import { STYLES } from './styles'
import { isUnnamedSession, sessionDisplayTitle, shortSessionId } from './session-display'
import { AcceptanceMaterialChips, MaterialFileSheet, MaterialLightbox, MaterialsSection, isPreviewableImage, openMaterialLink } from './Materials'
import { ArchivePane } from './ArchivePane'
import { DependencyGate, DependencyOverlay } from './BoardDependencies'

/** 读取已保存的列宽；没有/损坏时回到六列等分。 */
function readStoredColumnFr(): number[] {
  try {
    if (typeof window === 'undefined' || window.localStorage === null) return [...DEFAULT_BOARD_COLUMN_FR]
    const raw = window.localStorage.getItem(BOARD_COLUMN_FR_STORAGE_KEY)
    if (raw === null) return [...DEFAULT_BOARD_COLUMN_FR]
    return normalizeBoardColumnFr(JSON.parse(raw)) ?? [...DEFAULT_BOARD_COLUMN_FR]
  } catch {
    return [...DEFAULT_BOARD_COLUMN_FR]
  }
}

/** 列宽只影响界面偏好，失败静默。 */
function storeColumnFr(fr: readonly number[]): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage !== null) {
      window.localStorage.setItem(BOARD_COLUMN_FR_STORAGE_KEY, JSON.stringify(fr))
    }
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

/** Locale translate function handed in through the slot inject face. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Drawer session row label: `工作区 · 会话标题`（缺工作区名/标题时优雅降级，绝不只剩裸 id）。 */
function sessionLabel(row: TaskSessionLinkView, t: Translate): string {
  const workspace = row.workspaceName !== undefined && row.workspaceName.trim() !== '' ? row.workspaceName.trim() : ''
  const title = isUnnamedSession(row.sessionTitle)
    ? (row.sessionId !== undefined && row.sessionId !== '' ? shortSessionId(row.sessionId) : sessionDisplayTitle(row.sessionTitle, t))
    : (row.sessionTitle as string).trim()
  return workspace === '' ? title : `${workspace} · ${title}`
}

/** Face the plugin injects into the board page entry. */
export interface BoardInjected {
  store: CommanderStore
  t: Translate
  /** Switch the main panel back to the conversation. */
  closeBoard: () => void
  /** Open a DSH session from a card/drawer; absent when the service is unavailable. */
  openSession?: (sessionId: string) => void
}

/** Props received by the slot entry. */
export type BoardPageProps = BoardInjected

/** Drawer load state for one task. */
type DrawerState =
  | { phase: 'loading'; taskId: string }
  | { phase: 'ready'; taskId: string; detail: TaskDetailView }
  | { phase: 'error'; taskId: string; message: string }

/** Render the full board page. */
export function BoardPage({ store, t, openSession }: BoardPageProps): ReactNode {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [tab, setTab] = React.useState<'board' | 'trash'>('board')
  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [columnFr, setColumnFr] = React.useState<number[]>(() => readStoredColumnFr())
  const columnFrRef = React.useRef<number[]>(columnFr)
  columnFrRef.current = columnFr
  const [resizingColumns, setResizingColumns] = React.useState(false)
  const [hoveredTaskId, setHoveredTaskId] = React.useState<string | null>(null)
  const [expandedDeps, setExpandedDeps] = React.useState<ReadonlySet<string>>(new Set())
  const boardWrapRef = React.useRef<HTMLDivElement | null>(null)

  const pendingTaskIds = state.pendingDispatch?.taskId === undefined ? [] : [state.pendingDispatch.taskId]
  const grouped = groupBoardTasks(state.tasks, pendingTaskIds)
  const workspaceName = (workspaceId: string | undefined): string => workspaceNameOf(state, workspaceId)
  const taskById = React.useMemo(() => new Map(state.tasks.map(task => [task.id, task])), [state.tasks])
  const downstream = React.useMemo(() => downstreamCounts(state.tasks), [state.tasks])
  // 悬停优先；打开详情抽屉时把该任务的链固定在高亮状态（看板始终开着，抽屉关闭即恢复）。
  const activeTaskId = hoveredTaskId ?? drawer?.taskId ?? null
  const activeChain = React.useMemo(
    () => (activeTaskId === null ? null : dependencyHighlightChain(state.tasks, activeTaskId)),
    [activeTaskId, state.tasks],
  )
  // 切到回收站时清掉悬停态，避免回到看板时残留一条旧链。
  React.useEffect(() => { setHoveredTaskId(null) }, [tab])
  const toggleDeps = React.useCallback((taskId: string): void => {
    setExpandedDeps(current => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const beginColumnResize = (event: React.PointerEvent<HTMLSpanElement>, index: number): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const grid = boardWrapRef.current?.querySelector<HTMLElement>('.dshc-board-columns')
    if (grid === null || grid === undefined) return
    const widths = [...grid.querySelectorAll<HTMLElement>('.dshc-board-column')].map(element => element.getBoundingClientRect().width)
    const available = widths.reduce((sum, width) => sum + width, 0)
    if (widths.length !== DEFAULT_BOARD_COLUMN_FR.length || available <= 0) return
    const startX = event.clientX
    const startFr = [...columnFrRef.current]
    setResizingColumns(true)
    const onMove = (moveEvent: PointerEvent): void => {
      const next = resizeBoardColumnFr(startFr, index, moveEvent.clientX - startX, available)
      columnFrRef.current = next
      setColumnFr(next)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      setResizingColumns(false)
      storeColumnFr(columnFrRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const resetColumnWidths = (): void => {
    const next = [...DEFAULT_BOARD_COLUMN_FR]
    columnFrRef.current = next
    setColumnFr(next)
    storeColumnFr(next)
  }

  const openDrawer = (taskId: string): void => {
    setDrawer({ phase: 'loading', taskId })
    void store.getTaskDetail(taskId).then(result => {
      if (result.ok) {
        setDrawer({ phase: 'ready', taskId, detail: result.data })
        return
      }
      setDrawer({ phase: 'error', taskId, message: result.failure.message })
    })
  }

  const refreshDrawer = (taskId: string): void => {
    void store.getTaskDetail(taskId).then(result => {
      if (result.ok) setDrawer({ phase: 'ready', taskId, detail: result.data })
    })
  }

  const archiveTask = (task: TaskView): void => {
    void store.archiveTask(task.id).then(result => {
      if (result.ok && drawer !== null && drawer.taskId === task.id) setDrawer(null)
    })
  }

  const cancelTask = (task: TaskView): void => {
    void store.cancelTask(task.id).then(result => {
      if (result.ok && drawer !== null && drawer.taskId === task.id) setDrawer(null)
    })
  }

  const restoreTask = async (task: TaskView): Promise<boolean> => {
    const result = await store.restoreTask(task.id)
    return result.ok
  }

  const changePriority = (task: TaskView, priority: string): void => {
    void store.patchBoardTask(task.id, buildBoardPatch('priority', priority)).then(result => {
      if (result.ok) refreshDrawer(task.id)
    })
  }

  const acceptTask = (task: TaskView, note?: string): void => {
    void store.acceptTask(task.id, note).then(result => {
      if (result.ok) refreshDrawer(task.id)
    })
  }

  const reworkTask = (task: TaskView, comment: string): void => {
    void store.reworkTask(task.id, comment).then(result => {
      if (result.ok) refreshDrawer(task.id)
    })
  }

  const changeTitle = (task: TaskView, title: string): void => {
    const value = title.trim()
    if (value === '' || value === task.title) return
    void store.patchBoardTask(task.id, buildBoardPatch('title', value.slice(0, 200))).then(result => {
      if (result.ok) refreshDrawer(task.id)
    })
  }

  const drawerTask = drawer === null ? undefined : findDrawerTask(state, drawer)
  const drawerSnapshotTask = drawer === null ? undefined : state.tasks.find(row => row.id === drawer.taskId)
  // 工作会话 turn/start|end、commander_task_report 等 Host 侧变化会推整行 task.updated；
  // 抽屉里的会话状态/最近更新来自 GET tasks/:id，打开后不会自己变，快照行变新就重拉一次。
  React.useEffect(() => {
    if (drawer === null || drawer.phase !== 'ready' || drawer.detail.task === undefined) return
    const snapshotUpdated = drawerSnapshotTask?.updatedAt ?? 0
    const detailUpdated = drawer.detail.task.updatedAt ?? 0
    if (snapshotUpdated <= detailUpdated) return
    refreshDrawer(drawer.taskId)
  }, [drawer, drawerSnapshotTask?.updatedAt])

  return (
    <div className="dshc-board dshc-root" aria-label={t('board.title')}>
      <style>{STYLES}</style>

      <header className="dshc-board-header">
        <div className="dshc-board-tabs" role="tablist" aria-label={t('board.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'board'}
            className="dshc-board-tab"
            data-active={tab === 'board' ? 'true' : 'false'}
            onClick={() => { setTab('board') }}
          >
            {t('board.tab.board')}
            <span className="dshc-board-tab-count">{BOARD_COLUMNS.reduce((sum, column) => sum + grouped[column.id].length, 0)}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'trash'}
            className="dshc-board-tab"
            data-active={tab === 'trash' ? 'true' : 'false'}
            onClick={() => { setTab('trash') }}
          >
            {t('board.tab.trash')}
            <span className="dshc-board-tab-count">{trashCount(state)}</span>
          </button>
        </div>
      </header>

      {tab === 'board' ? (
        <div className="dshc-board-columns-wrap" ref={boardWrapRef}>
          <div
            className="dshc-board-columns"
            data-resizing={resizingColumns ? 'true' : 'false'}
            style={{ gridTemplateColumns: columnFr.map(fr => `minmax(${String(BOARD_COLUMN_MIN_PX)}px, ${String(fr)}fr)`).join(' ') }}
          >
          {BOARD_COLUMNS.map((column, columnIndex) => (
            <section key={column.id} className="dshc-board-column">
              <header className="dshc-board-column-head">
                <span className="dshc-board-column-title">{t(column.labelKey)}</span>
                <span className="dshc-board-count">{grouped[column.id].length}</span>
              </header>
              <div className="dshc-board-column-body">
                {grouped[column.id].length === 0 ? (
                  <div className="dshc-board-column-empty">{t('board.column.empty')}</div>
                ) : null}
                {grouped[column.id].map(task => {
                  const inChain = activeChain !== null && activeChain.has(task.id)
                  return (
                  <article
                    key={task.id}
                    className="dshc-board-card"
                    data-task-id={task.id}
                    data-status={task.status ?? ''}
                    data-pending-dispatch={hasPendingDispatch(task, pendingTaskIds) ? 'true' : 'false'}
                    data-dep-dim={activeChain !== null && !inChain ? 'true' : 'false'}
                    data-dep-chain={inChain ? 'true' : 'false'}
                    data-dep-active={activeChain !== null && activeTaskId === task.id ? 'true' : 'false'}
                    tabIndex={0}
                    role="button"
                    aria-label={task.title ?? task.id}
                    onClick={() => { openDrawer(task.id) }}
                    onMouseEnter={() => { setHoveredTaskId(task.id) }}
                    onMouseLeave={() => { setHoveredTaskId(current => (current === task.id ? null : current)) }}
                    onFocus={() => { setHoveredTaskId(task.id) }}
                    onBlur={event => {
                      const next = event.relatedTarget
                      if (next instanceof Node && event.currentTarget.contains(next)) return
                      setHoveredTaskId(current => (current === task.id ? null : current))
                    }}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(task.id) } }}
                  >
                    <div className="dshc-board-card-head">
                      <span className="dshc-board-card-title">{task.title ?? task.id}</span>
                    </div>
                    <div className="dshc-board-card-meta">
                      <span className="dshc-board-card-workspace">{workspaceName(task.workspaceId)}</span>
                      <span className="dshc-board-round" data-current={(task.round ?? 1) > 1 ? 'true' : 'false'}>{t('board.round.badge', { round: task.round ?? 1 })}</span>
                      <span className="dshc-board-priority" data-priority={task.priority ?? 'normal'}>{t(priorityLabelKey(task.priority))}</span>
                      {(downstream.get(task.id) ?? 0) > 0 ? <span className="dshc-board-downstream">{t('board.card.downstream', { n: downstream.get(task.id) ?? 0 })}</span> : null}
                    </div>
                    <DependencyGate
                      task={task}
                      taskById={taskById}
                      t={t}
                      expanded={expandedDeps.has(task.id)}
                      onToggle={() => { toggleDeps(task.id) }}
                    />
                    {(() => {
                      const pending = hasPendingDispatch(task, pendingTaskIds)
                      const badges: ReactNode[] = []
                      if (pending) badges.push(<span key="pending" className="dshc-board-badge" data-tone="pending">{t('board.card.pendingConfirm')}</span>)
                      if (task.pendingContinue === true) badges.push(<span key="continue" className="dshc-board-badge" data-tone="continue">{t('board.card.continueDispatch')}</span>)
                      return badges.length === 0 ? null : <div className="dshc-board-card-badges">{badges}</div>
                    })()}
                    {task.block?.reason === undefined && task.block?.code === undefined ? null : (
                      <div className="dshc-board-card-block">
                        {`${t('board.card.blocked')}：${task.block?.code ?? task.block?.reason ?? ''}`}
                      </div>
                    )}
                    <div className="dshc-board-card-foot">
                      <span>{formatBoardTime(task.lastActivityAt ?? task.updatedAt)}</span>
                      {(() => {
                        const capability = capabilitySummary(task)
                        // 没有实际能力（继承 / 空 fallback）时不显示「能力 0/0」——数量为 0 没有信息量。
                        if (capability === undefined || capability.status === 'none' || capabilityTotal(capability) === 0) return null
                        const enabled = capability.enabledCount
                        const total = capabilityTotal(capability)
                        // 没有未启用项时不显示 `N/N`（Host 目前 disabled 恒为空，分母没有信息量）。
                        const count = capability.disabledCount > 0 ? `${enabled}/${total}` : String(enabled)
                        return <span title={t('task.capabilityHint')}>{`${t('task.capability')} (${count})`}</span>
                      })()}
                    </div>
                    <div className="dshc-board-card-actions">
                      {task.primarySessionId === undefined || openSession === undefined ? null : (
                        <button
                          type="button"
                          className="dshc-msg-toggle"
                          onClick={event => { event.stopPropagation(); openSession(task.primarySessionId ?? '') }}
                        >
                          {t('board.action.openSession')}
                        </button>
                      )}
                      {canCancelTask(task) ? (
                        <button
                          type="button"
                          className="dshc-msg-toggle"
                          onClick={event => { event.stopPropagation(); cancelTask(task) }}
                        >
                          {t('board.action.cancel')}
                        </button>
                      ) : null}
                      {canArchiveTask(task) ? (
                        <button
                          type="button"
                          className="dshc-msg-toggle"
                          onClick={event => { event.stopPropagation(); archiveTask(task) }}
                        >
                          {t('board.action.archive')}
                        </button>
                      ) : null}
                    </div>
                  </article>
                  )
                })}
              </div>
              {columnIndex < BOARD_COLUMNS.length - 1 ? (
                <span
                  className="dshc-board-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('board.columns.resize')}
                  title={t('board.columns.resize')}
                  onPointerDown={event => { beginColumnResize(event, columnIndex) }}
                  onDoubleClick={event => { event.preventDefault(); resetColumnWidths() }}
                />
              ) : null}
            </section>
          ))}
          </div>
          <DependencyOverlay
            tasks={state.tasks}
            activeTaskId={activeChain === null ? null : activeTaskId}
            wrapRef={boardWrapRef}
            layoutKey={`${columnFr.join(',')}:${[...expandedDeps].sort().join(',')}:${String(state.rev)}`}
          />
        </div>
      ) : (
        <ArchivePane
          store={store}
          t={t}
          workspaces={state.workspaces.map(workspace => ({ id: workspace.id }))}
          workspaceName={workspaceName}
          allTotal={trashCount(state)}
          onRestore={restoreTask}
        />
      )}

      {drawer === null ? null : (
        <TaskDrawer
          t={t}
          drawer={drawer}
          task={drawerTask}
          state={state}
          openSession={openSession}
          onClose={() => { setDrawer(null) }}
          onArchive={archiveTask}
          onCancel={cancelTask}
          onPriority={changePriority}
          onTitle={changeTitle}
          onAccept={acceptTask}
          onRework={reworkTask}
        />
      )}
    </div>
  )
}

const SESSION_STATUS_KEYS: Readonly<Record<string, string>> = {
  queued: 'board.drawer.sessionStatus.queued',
  running: 'board.drawer.sessionStatus.running',
  idle: 'board.drawer.sessionStatus.idle',
  missing: 'board.drawer.sessionStatus.missing',
}

const DISPATCH_OUTCOME_KEYS: Readonly<Record<string, string>> = {
  auto: 'board.drawer.outcome.auto',
  confirmed: 'board.drawer.outcome.confirmed',
  overridden: 'board.drawer.outcome.overridden',
  cancelled: 'board.drawer.outcome.cancelled',
  jev_unavailable: 'board.drawer.outcome.jevUnavailable',
  rejected: 'board.drawer.outcome.rejected',
}

function sessionStatusKey(status: string | undefined): string {
  const key = status === undefined ? undefined : SESSION_STATUS_KEYS[status]
  return key ?? 'board.drawer.sessionStatus.unknown'
}

function dispatchOutcomeKey(outcome: string | undefined): string {
  const key = outcome === undefined ? undefined : DISPATCH_OUTCOME_KEYS[outcome]
  return key ?? 'board.drawer.outcome.other'
}

const EDIT_FIELD_KEYS: Readonly<Record<string, string>> = {
  status: 'board.field.status',
  priority: 'board.field.priority',
  title: 'board.field.title',
}

function editFieldKey(field: string | undefined): string {
  const key = field === undefined ? undefined : EDIT_FIELD_KEYS[field]
  return key ?? 'board.field.title'
}

function formatEditValue(field: string | undefined, value: unknown, t: Translate): string {
  if (typeof value === 'string') {
    if (field === 'status') return t(statusLabelKey(value))
    if (field === 'priority') return t(priorityLabelKey(value))
  }
  return stringifyEditValue(value)
}

function roundTargetLabel(round: TaskRoundView, state: CommanderView, t: Translate, fallbackWorkspaceId?: string): string {
  const target = round.dispatch?.finalTarget
  const workspaceId = target?.workspaceId ?? fallbackWorkspaceId
  const name = workspaceNameOf(state, workspaceId)
  return target?.mode === 'new' || target?.mode === 'attach'
    ? `${name} · ${t(target.mode === 'new' ? 'dispatch.mode.new' : 'dispatch.mode.attach')}`
    : name
}

function roundTimeRange(round: TaskRoundView): string {
  const start = round.startedAt === undefined ? '' : formatClockTime(round.startedAt)
  const end = round.endedAt === undefined ? '' : formatClockTime(round.endedAt)
  if (start === '' && end === '') return ''
  if (start === '' || end === '' || start === end) return start || end
  return `${start}–${end}`
}

function roundEventText(item: { type?: string; text?: string }, t: Translate): string {
  const text = item.text ?? ''
  if (item.type === 'status') {
    const match = /^状态\s*->\s*([a-z_]+)$/u.exec(text)
    if (match?.[1] !== undefined) return `${t('board.drawer.feed.statusChanged')} ${t(statusLabelKey(match[1]))}`
  }
  return text
}

function roundEventLabel(type: string | undefined, t: Translate): string {
  switch (type) {
    case 'created': return t('board.drawer.feed.created')
    case 'status': return t('board.drawer.feed.status')
    case 'user_edit': return t('board.drawer.feed.edit')
    case 'accept': return t('board.drawer.feed.accept')
    case 'session_stop': return t('board.drawer.feed.sessionStop')
    case 'rework': return t('board.drawer.feed.rework')
    case 'continue': return t('board.drawer.feed.continue')
    case 'continue_request': return t('board.drawer.feed.continueRequest')
    default: return t('board.drawer.feed.status')
  }
}

function RoundEvent({ kind, at, label, extra, children }: {
  kind: string
  at?: number | undefined
  label: string
  extra?: ReactNode | undefined
  children: ReactNode
}): ReactNode {
  return (
    <article className="dshc-d-round-ev" data-kind={kind}>
      <div className="dshc-d-round-rail" aria-hidden><span /></div>
      <div className="dshc-d-round-ev-main">
        <div className="dshc-d-round-ev-meta">
          {at === undefined ? null : <time>{formatClockTime(at)}</time>}
          <span className="dshc-d-round-ev-kind">{label}</span>
          {extra}
        </div>
        {children}
      </div>
    </article>
  )
}

function DispatchBriefBlock({ dispatch, t, workspaceName }: {
  dispatch: TaskDispatchDetailView
  t: Translate
  workspaceName: (workspaceId: string | undefined) => string
}): ReactNode {
  const [expanded, setExpanded] = React.useState(false)
  const brief = dispatch.brief ?? ''
  return (
    <div className="dshc-d-brief-card">
      <div className="dshc-d-brief-head">
        <b>{t('board.drawer.dispatchContent')}</b>
        <span>{t('board.drawer.dispatchNote')}</span>
        {brief === '' ? null : (
          <button type="button" className="dshc-d-link" onClick={() => { setExpanded(value => !value) }}>
            {expanded ? t('board.drawer.collapseBrief') : t('board.drawer.expandBrief')}
          </button>
        )}
      </div>
      {brief === ''
        ? <p className="dshc-d-brief-empty">{t('board.drawer.briefMissing')}</p>
        : <pre className="dshc-d-brief" data-open={expanded ? 'true' : 'false'}>{brief}</pre>}
      <DispatchReceipt dispatch={dispatch} at={dispatch.createdAt} t={t} workspaceName={workspaceName} />
    </div>
  )
}

function RoundSection({ round, task, state, t, openSession, acceptanceRef, expanded, onToggle }: {
  round: TaskRoundView
  task: TaskView
  state: CommanderView
  t: Translate
  openSession: ((sessionId: string) => void) | undefined
  acceptanceRef: React.MutableRefObject<HTMLElement | null>
  expanded: boolean
  onToggle: () => void
}): ReactNode {
  const summary = acceptanceSummary(round.acceptance)
  const materials = round.materials ?? []
  const imageMaterials = materials.filter(isPreviewableImage)
  const [previewId, setPreviewId] = React.useState<string | null>(null)
  const [fileMaterial, setFileMaterial] = React.useState<ReportMaterialView | null>(null)
  const materialsRef = React.useRef<HTMLDivElement | null>(null)
  const previewIndex = previewId === null ? -1 : imageMaterials.findIndex((material) => material.id === previewId)
  React.useEffect(() => {
    setPreviewId(null)
    setFileMaterial(null)
  }, [round.round])
  React.useEffect(() => {
    if (!expanded) {
      setPreviewId(null)
      setFileMaterial(null)
    }
  }, [expanded])
  const openMaterial = (material: ReportMaterialView): void => {
    if (isPreviewableImage(material)) {
      setPreviewId(material.id ?? '')
      return
    }
    if (material.kind === 'link') {
      openMaterialLink(material.url)
      return
    }
    setFileMaterial(material)
  }
  const dispatch = round.dispatch
  const target = roundTargetLabel(round, state, t, task.workspaceId)
  const timeRange = roundTimeRange(round)
  const created = round.timeline.find(item => item.type === 'created')
  const reportEvent = [...round.timeline].reverse().find(item => item.type === 'report')
  const simple = round.timeline.filter(item => {
    if (item.type === 'created' || item.type === 'dispatch' || item.type === 'report' || item.type === 'continue') return false
    if (item.type === 'continue_request' && round.userRequest !== undefined) return false
    return true
  })
  return (
    <section className="dshc-d-round" data-current={round.isCurrent ? 'true' : 'false'} id={`dshc-round-${String(round.round)}`}>
      <header className="dshc-d-round-head">
        <div className="dshc-d-round-head-main">
          <span className="dshc-d-round-index">{t('board.round.badge', { round: round.round })}</span>
          <span className="dshc-d-round-target">{target}</span>
          {round.isCurrent ? <span className="dshc-d-round-current">{t('board.drawer.currentRound')}</span> : null}
        </div>
        <div className="dshc-d-round-head-right">
          {timeRange === '' ? null : <span className="dshc-d-round-time">{timeRange}</span>}
          {round.acceptance.length === 0 ? null : <span className="dshc-d-round-acc">{`${String(summary.evidence)}/${String(summary.total)}`}</span>}
          {materials.length === 0 ? null : <span className="dshc-d-round-mat">{t('board.drawer.materialsShort', { count: String(materials.length) })}</span>}
          <button type="button" className="dshc-d-link" onClick={onToggle}>
            {expanded ? t('board.drawer.collapse') : t('board.drawer.expand')}
          </button>
        </div>
      </header>
      {expanded ? (
        <div className="dshc-d-round-events">
          {created === undefined ? null : (
            <RoundEvent kind="created" at={created.at} label={roundEventLabel('created', t)}>
              <p className="dshc-d-round-text">{roundEventText(created, t)}</p>
            </RoundEvent>
          )}
          {round.userRequest === undefined ? null : (
            <RoundEvent
              kind="user"
              at={round.userRequest.at}
              label={t('board.drawer.userRequest')}
              extra={
                <span className="dshc-d-round-source">
                  {t(round.userRequest.source === 'board' ? 'board.drawer.source.board' : 'board.drawer.source.chat')}
                </span>
              }
            >
              <blockquote className="dshc-d-user-quote">{round.userRequest.text}</blockquote>
            </RoundEvent>
          )}
          {dispatch === undefined ? null : (
            <RoundEvent
              kind="dispatch"
              at={dispatch.createdAt}
              label={t('board.drawer.feed.dispatch')}
              extra={<span className="dshc-d-round-target">{target}</span>}
            >
              <DispatchBriefBlock dispatch={dispatch} t={t} workspaceName={workspaceId => workspaceNameOf(state, workspaceId)} />
            </RoundEvent>
          )}
          {round.sessions.length === 0 ? null : (
            <RoundEvent kind="session" at={dispatch?.createdAt ?? round.startedAt} label={t('board.drawer.workSession')}>
              <div className="dshc-d-round-sessions">
                {round.sessions.map((row, index) => (
                  <DrawerSessionCard
                    key={row.sessionId ?? `round_${String(round.round)}_session_${String(index)}`}
                    row={row}
                    t={t}
                    primary={row.sessionId !== undefined && row.sessionId === task.primarySessionId}
                    onOpen={openSession === undefined || row.sessionId === undefined
                      ? undefined
                      : () => { openSession(row.sessionId ?? '') }}
                  />
                ))}
              </div>
            </RoundEvent>
          )}
          {round.acceptance.length === 0 && round.reportSummary === undefined && materials.length === 0 ? null : (
            <RoundEvent
              kind="report"
              at={reportEvent?.at ?? round.endedAt}
              label={t('board.drawer.feed.report')}
              extra={round.acceptance.length === 0 && materials.length === 0
                ? undefined
                : (
                  <span className="dshc-d-round-report-badges">
                    {round.acceptance.length === 0 ? null : <span className="dshc-d-round-ok">{`${String(summary.evidence)}/${String(summary.total)} ${t('board.drawer.evidenceShort')}`}</span>}
                    {materials.length === 0 ? null : <span className="dshc-d-mat-badge">{t('board.drawer.materialsShort', { count: String(materials.length) })}</span>}
                  </span>
                  )}
            >
              <div ref={round.isCurrent ? node => { acceptanceRef.current = node } : undefined}>
                {round.reportSummary === undefined ? null : (
                  <ConclusionCard
                    text={round.reportSummary}
                    t={t}
                    materials={materials}
                    onViewMaterials={() => { materialsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
                  />
                )}
                {materials.length === 0 ? null : (
                  <MaterialsSection materials={materials} t={t} sectionRef={materialsRef} onOpen={openMaterial} />
                )}
                {round.acceptance.length === 0 ? null : <AcceptanceList rows={round.acceptance} t={t} materials={materials} onMaterial={openMaterial} />}
              </div>
            </RoundEvent>
          )}
          {round.edits.map((edit, index) => (
            <RoundEvent key={`round_${String(round.round)}_edit_${String(index)}`} kind="user_edit" at={edit.at} label={t('board.drawer.feed.edit')}>
              <p className="dshc-d-round-text">
                {`${t(editFieldKey(edit.field))}：${formatEditValue(edit.field, edit.before, t)} → ${formatEditValue(edit.field, edit.after, t)}`}
              </p>
            </RoundEvent>
          ))}
          {simple.map((item, index) => (
            <RoundEvent key={`round_${String(round.round)}_simple_${String(index)}`} kind={item.type ?? 'status'} at={item.at} label={roundEventLabel(item.type, t)}>
              <p className="dshc-d-round-text">{roundEventText(item, t)}</p>
            </RoundEvent>
          ))}
        </div>
      ) : (
        <p className="dshc-d-round-summary">
          {round.userRequest?.text ?? (round.reportSummary ?? '')}
          {round.acceptance.length === 0 ? '' : ` · ${String(summary.evidence)}/${String(summary.total)} ${t('board.drawer.evidenceShort')}`}
          {materials.length === 0 ? '' : ` · ${t('board.drawer.materialsShort', { count: String(materials.length) })}`}
        </p>
      )}
      {expanded && previewIndex >= 0 ? (
        <MaterialLightbox
          images={imageMaterials}
          index={previewIndex}
          t={t}
          onChange={(index) => { setPreviewId(imageMaterials[index]?.id ?? null) }}
          onClose={() => { setPreviewId(null) }}
        />
      ) : null}
      {expanded && fileMaterial !== null ? (
        <MaterialFileSheet material={fileMaterial} t={t} onClose={() => { setFileMaterial(null) }} />
      ) : null}
    </section>
  )
}

function PendingContinueCard({ text, at, t }: { text: string; at?: number | undefined; t: Translate }): ReactNode {
  return (
    <div className="dshc-d-pending-continue">
      <div className="dshc-d-pending-head">
        <b>{t('board.drawer.pendingContinue')}</b>
        {at === undefined ? null : <time>{formatClockTime(at)}</time>}
      </div>
      <p>{text}</p>
    </div>
  )
}

/** Right-side task detail drawer (scheme D: title first, then round-by-round review). */
function TaskDrawer({
  t, drawer, task, state, openSession, onClose, onArchive, onCancel, onPriority, onTitle, onAccept, onRework,
}: {
  t: Translate
  drawer: DrawerState
  task: TaskView | undefined
  state: CommanderView
  openSession: ((sessionId: string) => void) | undefined
  onClose: () => void
  onArchive: (task: TaskView) => void
  onCancel: (task: TaskView) => void
  onPriority: (task: TaskView, priority: string) => void
  onTitle: (task: TaskView, title: string) => void
  onAccept: (task: TaskView, note?: string) => void
  onRework: (task: TaskView, comment: string) => void
}): ReactNode {
  const [confirmAccept, setConfirmAccept] = React.useState(false)
  const [acceptNote, setAcceptNote] = React.useState('')
  const [showRework, setShowRework] = React.useState(false)
  const [reworkComment, setReworkComment] = React.useState('')
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [expandedHistory, setExpandedHistory] = React.useState<Set<number>>(new Set())
  const [currentCollapsed, setCurrentCollapsed] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const acceptanceRef = React.useRef<HTMLElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    setConfirmAccept(false)
    setAcceptNote('')
    setShowRework(false)
    setReworkComment('')
    setMenuOpen(false)
    setExpandedHistory(new Set())
    setCurrentCollapsed(false)
  }, [drawer.taskId])

  // Every task opens at its beginning (oldest round); the current review sits at the bottom.
  React.useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0
  }, [drawer.taskId])

  React.useEffect(() => {
    if (!menuOpen) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && event.target instanceof Node && menuRef.current.contains(event.target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [menuOpen])

  const rounds = React.useMemo(
    () => (task !== undefined && drawer.phase === 'ready' ? buildTaskRounds(task, drawer.detail) : []),
    [task, drawer],
  )
  const currentRound = rounds.find(round => round.isCurrent) ?? rounds[rounds.length - 1]
  const acceptance = currentRound?.acceptance ?? []
  const summary = acceptanceSummary(acceptance)
  const workspaceCount = task === undefined
    ? 0
    : Array.isArray(task.workspaceIds) && task.workspaceIds.length > 0
      ? task.workspaceIds.length
      : (task.workspaceId === undefined || task.workspaceId === '' ? 0 : 1)

  const isExpanded = (round: TaskRoundView): boolean => round.isCurrent ? !currentCollapsed : expandedHistory.has(round.round)
  const toggleRound = (round: TaskRoundView): void => {
    if (round.isCurrent) {
      setCurrentCollapsed(value => !value)
      return
    }
    setExpandedHistory(previous => {
      const next = new Set(previous)
      if (next.has(round.round)) next.delete(round.round)
      else next.add(round.round)
      return next
    })
  }
  const expandRound = (round: TaskRoundView): void => {
    if (round.isCurrent) setCurrentCollapsed(false)
    else setExpandedHistory(previous => new Set([...previous, round.round]))
  }
  const jumpToRound = (round: TaskRoundView): void => {
    expandRound(round)
    window.setTimeout(() => {
      const node = document.getElementById(`dshc-round-${String(round.round)}`)
      if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }
  const jumpToAcceptance = (): void => {
    setCurrentCollapsed(false)
    window.setTimeout(() => {
      const node = acceptanceRef.current
      if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const closeButton = (
    <button type="button" className="dshc-icon-button" aria-label={t('board.drawer.close')} title={t('board.drawer.close')} onClick={onClose}>
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden>
        <path d="M6 6l12 12" /><path d="M18 6L6 18" />
      </svg>
    </button>
  )

  if (drawer.phase !== 'ready' || task === undefined) {
    return (
      <React.Fragment>
        <div className="dshc-board-mask" onClick={onClose} aria-hidden />
        <aside className="dshc-board-drawer" role="dialog" aria-label={t('board.drawer.title')}>
          <header className="dshc-d-head dshc-d-head--slim">
            <span className="dshc-d-slim-title">{t('board.drawer.title')}</span>
            {closeButton}
          </header>
          <div className="dshc-board-state">
            {drawer.phase === 'error' ? `${t('board.error.load')}：${drawer.message}` : t('board.loading')}
          </div>
        </aside>
      </React.Fragment>
    )
  }

  const detail = drawer.detail
  const canOpenPrimary = task.primarySessionId !== undefined && task.primarySessionId !== '' && openSession !== undefined
  const canArchive = canArchiveTask(task)
  const canCancel = canCancelTask(task)
  const titleOf = (id: string): string => state.tasks.find(row => row.id === id)?.title ?? id
  const nowHint = ((): string => {
    switch (task.status) {
      case 'review':
        return t('board.drawer.waitingReview')
      case 'running':
      case 'queued':
        return t('board.drawer.inProgress')
      case 'blocked':
        return task.block?.code ?? task.block?.reason ?? t('board.drawer.blockedHint')
      case 'done':
      case 'cancelled':
      case 'archived':
        return t('board.drawer.closed')
      default:
        return t('board.drawer.waitingDispatch')
    }
  })()

  const commitTitle = (value: string): void => {
    const next = value.trim()
    if (next === '' || next === (task.title ?? '')) return
    onTitle(task, next)
  }

  return (
    <React.Fragment>
      <div className="dshc-board-mask" onClick={onClose} aria-hidden />
      <aside className="dshc-board-drawer" role="dialog" aria-label={t('board.drawer.title')}>
        <header className="dshc-d-head">
          <div className="dshc-d-head-actions" ref={menuRef}>
            {canOpenPrimary || canArchive || canCancel ? (
              <button
                type="button"
                className="dshc-icon-button"
                aria-label={t('board.drawer.more')}
                title={t('board.drawer.more')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => { setMenuOpen(open => !open) }}
              >
                <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
                  <circle cx="5.5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18.5" cy="12" r="1.5" />
                </svg>
              </button>
            ) : null}
            {menuOpen ? (
              <div className="dshc-d-menu" role="menu">
                {canOpenPrimary ? (
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openSession?.(task.primarySessionId ?? '') }}>
                    {t('board.action.openSession')}
                  </button>
                ) : null}
                {canCancel ? (
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onCancel(task) }}>
                    {t('board.action.cancel')}
                  </button>
                ) : null}
                {canArchive ? (
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onArchive(task) }}>
                    {t('board.action.archive')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {closeButton}
          </div>

          <input
            key={`${task.id}:${task.title ?? ''}`}
            className="dshc-d-title"
            defaultValue={task.title ?? ''}
            maxLength={200}
            aria-label={t('board.field.title')}
            onBlur={event => { commitTitle(event.currentTarget.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.currentTarget.value = task.title ?? ''
                event.currentTarget.blur()
              }
            }}
          />

          <div className="dshc-d-meta">
            <span className="dshc-d-status" data-status={task.status ?? 'other'}><i aria-hidden />{t(statusLabelKey(task.status))}</span>
            <span className="dshc-d-round-chip">{t('board.round.badge', { round: task.round ?? 1 })}</span>
            <span className="dshc-d-sep">·</span>
            <span className="dshc-d-workspace">{workspaceNameOf(state, task.workspaceId)} <em>{t('board.drawer.currentWorkspace')}</em></span>
            <span className="dshc-d-sep">·</span>
            <select
              className="dshc-d-priority"
              value={task.priority ?? 'normal'}
              aria-label={t('board.field.priority')}
              onChange={event => { onPriority(task, event.target.value) }}
            >
              {BOARD_PRIORITIES.map(priority => (
                <option key={priority} value={priority}>{t(priorityLabelKey(priority))}</option>
              ))}
            </select>
            <span className="dshc-d-sep">·</span>
            <span>{t('board.drawer.workspaceCount', { count: workspaceCount })}</span>
            <span className="dshc-d-sep">·</span>
            <span>{`${t('board.drawer.updated')} ${formatBoardTime(task.updatedAt)}`}</span>
            {acceptance.length === 0 ? null : (
              <button type="button" className="dshc-d-jump" onClick={jumpToAcceptance}>
                {`${t('board.drawer.roundAcceptance', { round: task.round ?? 1 })} ${String(summary.evidence)}/${String(summary.total)} ↓`}
              </button>
            )}
          </div>

          <ol className="dshc-d-steps" aria-label={t('board.drawer.progress')}>
            {TASK_STAGES.map((stage, index) => {
              const current = taskStage(task.status)
              const currentIndex = TASK_STAGES.indexOf(current)
              const state = taskTerminal(task.status) ? (index < TASK_STAGES.length - 1 ? 'done' : 'active') : index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo'
              const blocked = stage === 'running' && taskStageBlocked(task.status)
              return (
                <li
                  key={stage}
                  data-state={state}
                  data-tone={stage === 'review' || stage === 'done' ? 'success' : undefined}
                  data-blocked={blocked ? 'true' : 'false'}
                  data-terminal={taskTerminal(task.status) ? 'true' : 'false'}
                  data-stage={stage}
                >
                  <i aria-hidden />
                  <span>{t(`board.drawer.stage.${stage}`)}</span>
                </li>
              )
            })}
          </ol>

          <div className="dshc-d-deps">
            <div>
              <b>{t('board.drawer.dependsOn')}</b>{' '}
              {(task.dependsOn ?? []).length === 0 ? t('board.drawer.dependsOnNone') : (task.dependsOn ?? []).map(titleOf).join('、')}
            </div>
            {waitingFor(task).length === 0 ? null : (
              <div className="dshc-d-deps-waiting">{t('board.card.waitingFor', { tasks: waitingFor(task).map(titleOf).join('、') })}</div>
            )}
            {task.ready === true && (task.dependsOn ?? []).length > 0 ? <div className="dshc-d-deps-ready">{t('board.card.dependencyReady')}</div> : null}
            {hasPendingDispatch(task) ? <div className="dshc-d-deps-pending">{t('board.card.pendingConfirm')}</div> : null}
            {task.block?.reason === undefined ? null : (
              <div className="dshc-d-deps-block">{`${t('board.drawer.blockReason')}：${task.block.reason}`}</div>
            )}
            <details className="dshc-d-debug">
              <summary>{t('board.drawer.version', { version: task.version ?? 0 })}</summary>
              <pre>{JSON.stringify({ dependsOn: task.dependsOn ?? [], waitingFor: waitingFor(task), ready: task.ready === true, pendingDispatch: task.pendingDispatch === true }, null, 2)}</pre>
            </details>
          </div>

          {rounds.length > 1 ? (
            <nav className="dshc-d-rounds" aria-label={t('board.drawer.rounds')}>
              {rounds.map(round => (
                <button
                  key={round.round}
                  type="button"
                  className="dshc-d-round-tab"
                  data-current={round.isCurrent ? 'true' : 'false'}
                  onClick={() => { jumpToRound(round) }}
                >
                  <span className="dshc-d-round-tab-line">
                    <b>{t('board.round.badge', { round: round.round })}</b>
                    {round.isCurrent ? <em>{t('board.drawer.currentRound')}</em> : null}
                  </span>
                  <span className="dshc-d-round-tab-sub">{roundTargetLabel(round, state, t, task.workspaceId)}</span>
                </button>
              ))}
            </nav>
          ) : null}
        </header>

        <div className="dshc-d-body" ref={bodyRef}>
          <div className="dshc-d-rounds-body">
            {rounds.map(round => (
              <RoundSection
                key={round.round}
                round={round}
                task={task}
                state={state}
                t={t}
                openSession={openSession}
                acceptanceRef={acceptanceRef}
                expanded={isExpanded(round)}
                onToggle={() => { toggleRound(round) }}
              />
            ))}
            {detail.pendingInstruction?.text === undefined ? null : (
              <PendingContinueCard text={detail.pendingInstruction.text} at={detail.pendingInstruction.at} t={t} />
            )}
            {task.acceptNote?.text === undefined || task.acceptNote.text === '' ? null : (
              <div className="dshc-d-accept-note">
                <div className="dshc-d-accept-note-head">
                  <b>{t('board.drawer.acceptNote')}</b>
                  {task.acceptedBy === 'commander' ? <em>{t('board.drawer.acceptedByCommander')}</em> : null}
                </div>
                <p>{task.acceptNote.text}</p>
              </div>
            )}
            <div className="dshc-d-now" aria-current="step">
              <span className="dshc-d-now-dot" aria-hidden />
              <div className="dshc-d-now-main">
                <strong>{`${t('board.drawer.now')} · ${t(statusLabelKey(task.status))}`}{task.acceptedBy === 'commander' ? ` · ${t('board.drawer.acceptedByCommander')}` : ''}</strong>
                <p>{nowHint}</p>
              </div>
            </div>
          </div>
        </div>

        {task.status === 'review' ? (
          <footer className="dshc-d-foot">
            {showRework ? (
              <div className="dshc-d-rework">
                <div className="dshc-d-rework-head">
                  <b>{t('board.drawer.continueRound', { round: (task.round ?? 1) + 1 })}</b>
                  <span>{t('board.drawer.continueHint')}</span>
                </div>
                <textarea
                  className="dshc-field-textarea"
                  value={reworkComment}
                  maxLength={1000}
                  placeholder={t('board.rework.placeholder')}
                  aria-label={t('board.rework.placeholder')}
                  onChange={event => { setReworkComment(event.target.value) }}
                />
                <div className="dshc-d-rework-actions">
                  <button
                    type="button"
                    className="dshc-button"
                    data-variant="primary"
                    data-size="sm"
                    onClick={() => { setShowRework(false); onRework(task, reworkComment) }}
                  >
                    {t('board.rework.submit')}
                  </button>
                  <button type="button" className="dshc-button" data-variant="ghost" data-size="sm" onClick={() => { setShowRework(false) }}>
                    {t('board.accept.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <React.Fragment>
                {confirmAccept ? (
                  <div className="dshc-d-confirm">
                    <span>{t('board.accept.confirm')}</span>
                    {task.hasPendingDependents === true ? (
                      <textarea
                        className="dshc-field-textarea"
                        value={acceptNote}
                        maxLength={1000}
                        placeholder={t('board.accept.notePlaceholder')}
                        aria-label={t('board.accept.notePlaceholder')}
                        onChange={event => { setAcceptNote(event.target.value) }}
                      />
                    ) : null}
                    <div className="dshc-d-confirm-actions">
                      <button
                        type="button"
                        className="dshc-button"
                        data-variant="primary"
                        data-size="sm"
                        onClick={() => { setConfirmAccept(false); onAccept(task, acceptNote.trim() === '' ? undefined : acceptNote) }}
                      >
                        {t('board.accept.ok')}
                      </button>
                      <button
                        type="button"
                        className="dshc-button"
                        data-variant="ghost"
                        data-size="sm"
                        onClick={() => { setConfirmAccept(false); setAcceptNote('') }}
                      >
                        {t('board.accept.cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="dshc-d-foot-main">
                  <span className="dshc-d-foot-meta">{t('board.drawer.reviewHint')}</span>
                  <div className="dshc-d-foot-actions">
                    <button type="button" className="dshc-button" data-variant="secondary" onClick={() => { setConfirmAccept(false); setShowRework(true) }}>
                      {t('board.action.rework')}
                    </button>
                    <button type="button" className="dshc-button" data-variant="primary" onClick={() => { setShowRework(false); setConfirmAccept(true) }}>
                      {t('board.action.accept')}
                    </button>
                  </div>
                </div>
                <p className="dshc-d-foot-hint">
                  {task.pendingContinue === true ? t('board.drawer.pendingContinue') : t('board.drawer.reworkHint')}
                </p>
              </React.Fragment>
            )}
          </footer>
        ) : null}
      </aside>
    </React.Fragment>
  )
}

/** One session card inside a dispatch/session event. */
function DrawerSessionCard({ row, t, primary, onOpen }: {
  row: TaskSessionLinkView
  t: Translate
  primary: boolean
  onOpen: (() => void) | undefined
}): ReactNode {
  const workspace = row.workspaceName === undefined ? '' : row.workspaceName.trim()
  const title = isUnnamedSession(row.sessionTitle)
    ? (row.sessionId !== undefined && row.sessionId !== '' ? shortSessionId(row.sessionId) : t('board.drawer.unnamedSession'))
    : (row.sessionTitle ?? '')
  const role = row.role === 'commander' ? t('board.drawer.role.commander') : t('board.drawer.role.work')
  const meta = workspace === '' ? role : `${workspace} · ${role}`
  const content = (
    <React.Fragment>
      <span className="dshc-d-avatar" aria-hidden>{workspace === '' ? 'S' : workspace.slice(0, 1)}</span>
      <span className="dshc-d-session-main">
        <span className="dshc-d-session-title">{title}</span>
        <span className="dshc-d-session-sub">{meta}</span>
      </span>
      {primary ? <span className="dshc-d-chip">{t('board.drawer.primarySession')}</span> : null}
      {row.status === undefined ? null : <span className="dshc-d-chip" data-status={row.status}>{t(sessionStatusKey(row.status))}</span>}
      {onOpen === undefined ? null : (
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="dshc-d-session-chev" aria-hidden>
          <path d="M9.4 5.8 15.6 12l-6.2 6.2" />
        </svg>
      )}
    </React.Fragment>
  )
  if (onOpen === undefined) return <div className="dshc-d-session">{content}</div>
  return (
    <button type="button" className="dshc-d-session" onClick={onOpen} title={sessionLabel(row, t)}>
      {content}
    </button>
  )
}

/** Dispatch receipt attached to the dispatch timeline row. */
function DispatchReceipt({ dispatch, at, t, workspaceName }: {
  dispatch: TaskDispatchDetailView
  at: number | undefined
  t: Translate
  workspaceName: (workspaceId: string | undefined) => string
}): ReactNode {
  const pMax = normalizeProbability(dispatch.jev?.pMax)
  const candidates = dispatch.candidates ?? []
  const target = dispatch.finalTarget
  return (
    <div className="dshc-d-receipt">
      <div className="dshc-d-receipt-top">
        {pMax === undefined ? null : <span className="dshc-d-jev">{`Jev ${formatPercent(pMax)}`}</span>}
        <span>{t(dispatchOutcomeKey(dispatch.outcome))}</span>
      </div>
      {target === undefined ? null : (
        <p className="dshc-d-receipt-target">
          {`${workspaceName(target.workspaceId)} · ${t(target.mode === 'attach' ? 'dispatch.mode.attach' : 'dispatch.mode.new')}`}
        </p>
      )}
      <div className="dshc-d-receipt-sub">
        <span>{`${String(candidates.length)} ${t('board.drawer.candidates')}`}</span>
        {at === undefined ? null : (
          <React.Fragment>
            <span className="dshc-d-dot">·</span>
            <span>{`${t('board.drawer.confirmedAt')} ${formatClockTime(at)}`}</span>
          </React.Fragment>
        )}
      </div>
      {candidates.length === 0 ? null : (
        <details className="dshc-d-candidates">
          <summary>
            <span>{t('board.drawer.candidatesMore')}</span>
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5.8 9.2 12 15.4l6.2-6.2" />
            </svg>
          </summary>
          <ul>
            {candidates.slice(0, 6).map((candidate, index) => (
              <li key={`${candidate.workspaceId ?? 'w'}_${String(index)}`}>
                <span>{`${workspaceName(candidate.workspaceId)} · ${t(candidate.mode === 'attach' ? 'dispatch.mode.attach' : 'dispatch.mode.new')}`}</span>
                <span className="dshc-d-pct">{formatPercent(candidateProbability(candidate))}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** 「结论」卡：commander_task_report 的 summary，默认 4 行折叠；强调色用深蓝，避开证据勾的语义绿。 */
function ConclusionCard({ text, t, materials, onViewMaterials }: {
  text: string
  t: Translate
  materials?: readonly ReportMaterialView[]
  onViewMaterials?: () => void
}): ReactNode {
  const ref = React.useRef<HTMLParagraphElement | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [collapsible, setCollapsible] = React.useState(() => shouldCollapseSummary(text))
  React.useEffect(() => {
    const node = ref.current
    if (node === null || expanded) return
    const measure = (): void => {
      if (node.scrollHeight > node.clientHeight + 1) setCollapsible(true)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [text, expanded])
  return (
    <div className="dshc-d-conclusion" data-collapsible={collapsible ? 'true' : 'false'}>
      <div className="dshc-d-conclusion-head">
        <span className="dshc-d-conclusion-pill">{t('board.drawer.conclusion')}</span>
      </div>
      <p ref={ref} className="dshc-d-conclusion-text" data-expanded={expanded ? 'true' : 'false'}>{text}</p>
      {collapsible ? (
        <div className="dshc-d-conclusion-foot">
          <button
            type="button"
            className="dshc-d-conclusion-toggle"
            aria-expanded={expanded}
            onClick={() => { setExpanded(current => !current) }}
          >
            {expanded ? t('board.drawer.conclusionLess') : t('board.drawer.conclusionMore')}
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5.8 9.2 12 15.4l6.2-6.2" />
            </svg>
          </button>
        </div>
      ) : null}
      {materials === undefined || materials.length === 0 ? null : (
        <div className="dshc-d-conclusion-sources">
          <span>
            {t('board.drawer.materialsSummary', {
              images: String(materials.filter((material) => material.kind === 'image').length),
              links: String(materials.filter((material) => material.kind === 'link').length),
              files: String(materials.filter((material) => material.kind === 'file').length),
            })}
          </span>
          <button type="button" className="dshc-d-link" onClick={onViewMaterials}>{t('board.drawer.materialsView')}</button>
        </div>
      )}
    </div>
  )
}

/** Acceptance list: evidence summary is always visible, full evidence expands. */
function AcceptanceList({ rows, t, materials, onMaterial }: {
  rows: readonly TaskAcceptanceView[]
  t: Translate
  materials?: readonly ReportMaterialView[]
  onMaterial?: (material: ReportMaterialView) => void
}): ReactNode {
  return (
    <div className="dshc-d-checks">
      {rows.map((row, index) => {
        const evidence = row.evidence === undefined ? '' : row.evidence.trim()
        const verify = row.verify === undefined ? '' : row.verify.trim()
        const source = row.source === undefined ? '' : row.source.trim()
        const insufficient = row.state === 'insufficient'
        const hasFull = verify !== '' || source !== '' || evidence !== ''
        return (
          <div className="dshc-d-check" key={row.id ?? String(index)}>
            <span className="dshc-d-check-dot" data-state={insufficient ? 'insufficient' : 'present'} aria-hidden>
              {insufficient ? '!' : '✓'}
            </span>
            <div className="dshc-d-check-main">
              <p className="dshc-d-check-text">{row.text ?? t('board.drawer.empty')}</p>
              {hasFull ? (
                <details className="dshc-d-evfull">
                  <summary>
                    <span className="dshc-d-evtag">{t('board.drawer.evidence')}</span>
                    <span className="dshc-d-evsum" title={evidence || verify}>
                      {evidence || verify || (insufficient ? t('board.drawer.evidenceMissing') : '—')}
                    </span>
                    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5.8 9.2 12 15.4l6.2-6.2" />
                    </svg>
                  </summary>
                  <dl>
                    {evidence === '' ? null : <><dt>{t('board.drawer.evidence')}</dt><dd>{evidence}</dd></>}
                    {verify === '' ? null : <><dt>{t('board.drawer.verify')}</dt><dd>{verify}</dd></>}
                    {source === '' ? null : <><dt>{t('board.drawer.source')}</dt><dd>{source}</dd></>}
                  </dl>
                </details>
              ) : (
                <p className="dshc-d-evline">
                  <span className="dshc-d-evtag">{t('board.drawer.evidence')}</span>
                  <span className="dshc-d-evsum">
                    {insufficient ? t('board.drawer.evidenceMissing') : '—'}
                  </span>
                </p>
              )}
              {materials === undefined || materials.length === 0 || onMaterial === undefined ? null : (
                <AcceptanceMaterialChips materials={materials} acceptanceId={row.id} t={t} onOpen={onMaterial} />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function stringifyEditValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string') return value === '' ? '—' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '…'
}

function workspaceNameOf(state: CommanderView, workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId === '') return '—'
  const row = state.workspaces.find(workspace => workspace.id === workspaceId)
  return row?.name ?? row?.id ?? workspaceId
}

function trashCount(state: CommanderView): number {
  return archiveCount(state)
}

/**
 * Merge the snapshot row with the detail payload: `GET /commander/tasks/:id`
 * carries the authoritative task fields (workspaceId/status/priority/...), while
 * the snapshot row may be the only source before the detail request lands.
 */
function findDrawerTask(state: CommanderView, drawer: DrawerState): TaskView | undefined {
  const direct = state.tasks.find(task => task.id === drawer.taskId)
  const detailTask = drawer.phase === 'ready' ? drawer.detail.task : undefined
  if (direct !== undefined && detailTask !== undefined) {
    // 快照行是较新的一份（SSE task.updated 会整行覆盖）；详情只补它没有的字段。
    return { ...detailTask, ...direct, id: direct.id }
  }
  return direct ?? detailTask
}

