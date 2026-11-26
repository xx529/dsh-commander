/**
 * Moment-of-board pure helpers (M2, docs/architecture/m2m3-contract-patch.md §2).
 *
 * The board page renders five columns from the snapshot `tasks`; this module
 * owns the column mapping, legal human transitions, drag/drop payloads and
 * card formatting so they can be unit-tested without a DOM.
 */
import type {
  BoardEditView, BoardPatchRequest, ReportMaterialView, TaskAcceptanceRoundView, TaskAcceptanceView, TaskDetailView, TaskDispatchDetailView,
  TaskSessionLinkView, TaskTimelineView, TaskView,
} from './types'

/** Board column identifiers (six fixed columns + trash tab; task-state-machine-final §8.1). */
export type BoardColumnId = 'proposed' | 'queued' | 'running' | 'blocked' | 'review' | 'done'
/** Special bucket rendered as a tab/drawer instead of a column. */
export type BoardBucket = BoardColumnId | 'trash' | 'unknown'

/** One rendered board column. */
export interface BoardColumn {
  id: BoardColumnId
  /** Locale key of the column heading. */
  labelKey: string
  /** Task statuses that land in this column. */
  statuses: readonly string[]
}

/** The six columns in product order. There is no drag/drop: status moves through tools/human routes. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: 'proposed', labelKey: 'board.column.proposed', statuses: ['draft', 'proposed'] },
  { id: 'queued', labelKey: 'board.column.queued', statuses: ['queued'] },
  { id: 'running', labelKey: 'board.column.running', statuses: ['running'] },
  { id: 'blocked', labelKey: 'board.column.blocked', statuses: ['blocked'] },
  { id: 'review', labelKey: 'board.column.review', statuses: ['review'] },
  { id: 'done', labelKey: 'board.column.done', statuses: ['done'] },
]

/** Statuses shown in the trash tab (archived/cancelled). */
export const TRASH_STATUSES = ['archived', 'cancelled'] as const

/** Map a task status onto its column (or trash/unknown). */
export function boardColumnOf(status: string | undefined): BoardBucket {
  if (status === undefined) return 'unknown'
  for (const column of BOARD_COLUMNS) {
    if (column.statuses.includes(status)) return column.id
  }
  if ((TRASH_STATUSES as readonly string[]).includes(status)) return 'trash'
  return 'unknown'
}

/** Valid priority values for the priority editor. */
export const BOARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/** Locale key for a priority pill. */
export function priorityLabelKey(priority: string | undefined): string {
  switch (priority) {
    case 'low':
    case 'normal':
    case 'high':
    case 'urgent':
      return `board.priority.${priority}`
    default:
      return 'board.priority.normal'
  }
}

/** Locale key for a board status pill (same keys as the panel's task strip). */
export function statusLabelKey(status: string | undefined): string {
  if (status === undefined) return 'task.status.other'
  return `task.status.${status}`
}

/** Mint a `edit_<32hex>` id for one board edit (m2m3 patch §2.4). */
export function newEditId(prefix = 'edit'): string {
  // Contract: `edit_<32hex>` → 16 random bytes rendered as 32 hex characters.
  return `${prefix}_${randomHex(16)}`
}

/** Mint a request id matching the global `[A-Za-z0-9_-]{8,64}` rule. */
export function newBoardRequestId(): string {
  return `req_board_${randomHex(8)}`
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount)
  const cryptoObject = typeof globalThis.crypto === 'object' && globalThis.crypto !== null ? globalThis.crypto : undefined
  if (cryptoObject !== undefined && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes)
  } else {
    for (let index = 0; index < byteCount; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  let token = ''
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0')
  return token
}

/** Build the exact `PATCH /commander/board/tasks/:id` body. */
export function buildBoardPatch(
  field: BoardPatchRequest['field'],
  value: string,
  ids: { editId?: string; requestId?: string } = {},
): BoardPatchRequest {
  return {
    field,
    value,
    editId: ids.editId ?? newEditId(),
    requestId: ids.requestId ?? newBoardRequestId(),
  }
}

/** Sort one column's tasks per the frozen ordering rules. */
export function sortColumnTasks(column: BoardColumnId, tasks: readonly TaskView[], pendingTaskIds: readonly string[] = []): TaskView[] {
  const pending = new Set(pendingTaskIds)
  const rows = [...tasks]
  switch (column) {
    case 'proposed':
      return rows.sort((a, b) => {
        const rank = Number(pending.has(b.id)) - Number(pending.has(a.id))
        if (rank !== 0) return rank
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      })
    case 'queued':
    case 'running':
      return rows.sort((a, b) => (b.lastActivityAt ?? b.updatedAt ?? 0) - (a.lastActivityAt ?? a.updatedAt ?? 0))
    case 'blocked':
      return rows.sort((a, b) => (b.block?.since ?? b.updatedAt ?? 0) - (a.block?.since ?? a.updatedAt ?? 0))
    default:
      return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
}

/** Group snapshot tasks into the six columns (trash excluded; see `trashTasks`). */
export function groupBoardTasks(
  tasks: readonly TaskView[],
  pendingTaskIds: readonly string[] = [],
): Record<BoardColumnId, TaskView[]> {
  const grouped: Record<BoardColumnId, TaskView[]> = { proposed: [], queued: [], running: [], blocked: [], review: [], done: [] }
  for (const task of tasks) {
    const column = boardColumnOf(task.status)
    if (column === 'trash' || column === 'unknown') continue
    grouped[column].push(task)
  }
  for (const column of BOARD_COLUMNS) grouped[column.id] = sortColumnTasks(column.id, grouped[column.id], pendingTaskIds)
  return grouped
}

/** Trash rows from a snapshot/counts fallback (archived|cancelled). */
export function trashTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks
    .filter(task => (TRASH_STATUSES as readonly string[]).includes(task.status ?? ''))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** Archive is allowed from review/done/cancelled only (m2m3 patch §2.5). */
export function canArchiveTask(task: TaskView): boolean {
  return ['review', 'done', 'cancelled'].includes(task.status ?? '')
}

/** Restore is allowed for archived tasks only. */
export function canRestoreTask(task: TaskView): boolean {
  return task.status === 'archived'
}

/** Format an absolute timestamp for a card (short, host-locale aware). */
export function formatBoardTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/* ---------------------------------------------------------------------------
 * Task detail feed (M3 detail drawer, scheme D)
 *
 * The drawer tells one chronological story: the Host `timeline` is the spine,
 * structured payloads (dispatch receipt, acceptance, session cards, board-edit
 * diffs) attach to the timeline rows that produced them. Rows without a
 * timestamp (acceptance/sessions in older payloads) fall back to blocks at the
 * end, right above the "now" marker.
 * ------------------------------------------------------------------------- */

/** One timeline row the drawer can render as a feed event (plus two fallback kinds). */
export type TaskFeedKind =
  | 'created' | 'dispatch' | 'session_stop' | 'report' | 'status' | 'user_edit' | 'accept' | 'rework'
  | 'acceptance' | 'sessions'

/** One rendered feed event, with the structured payloads that belong to it. */
export interface TaskFeedEvent {
  id: string
  kind: TaskFeedKind
  at?: number
  text: string
  /** Timeline row session id (used to attach session cards to their event). */
  sessionId?: string
  /** Dispatch receipt; only the latest dispatch record is exposed by the Host. */
  dispatch?: TaskDispatchDetailView
  /** Acceptance list; attaches to the last `report` row, else becomes its own block. */
  acceptance?: readonly TaskAcceptanceView[]
  /** commander_task_report summary text; attaches to the same row as the acceptance list. */
  summary?: string
  /** Session cards attached to this event. */
  sessions?: readonly TaskSessionLinkView[]
  /** Human board edit matched by timestamp (before → after). */
  edit?: BoardEditView
}

const TIMELINE_KINDS: Readonly<Record<string, TaskFeedKind>> = {
  created: 'created',
  dispatch: 'dispatch',
  session_stop: 'session_stop',
  report: 'report',
  status: 'status',
  user_edit: 'user_edit',
  accept: 'accept',
  rework: 'rework',
}

/**
 * Build the drawer feed from the detail payload.
 *
 * Ordering: ascending `at` (oldest first), then untimed blocks (leftover
 * sessions, acceptance fallback) at the end. This is the contract the UI shows;
 * it does not invent timestamps.
 */
export function buildTaskFeed(task: TaskView, detail: TaskDetailView): TaskFeedEvent[] {
  const events: TaskFeedEvent[] = []
  // A pending continue request has no dispatch yet; render it via `pendingInstruction`,
  // not as a phantom next round with only a continue_request row.
  const timeline = (detail.timeline ?? []).filter(item => item.type !== 'continue_request')
  let lastDispatch: TaskFeedEvent | undefined
  let lastReport: TaskFeedEvent | undefined

  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]
    if (item === undefined) continue
    // 内部派发决策的 needs_confirmation 行对用户没有阅读价值（真正的等待态由状态/看板表达），
    // 且常带 decisionId/reason 技术串；有后续成功派发时更是噪音。
    if (item.type === 'dispatch' && (item.text ?? '').startsWith('needs_confirmation')) continue
    const kind = TIMELINE_KINDS[item.type ?? ''] ?? 'status'
    const event: TaskFeedEvent = {
      id: `tl_${String(index)}`,
      kind,
      text: item.text ?? '',
      ...(item.at !== undefined ? { at: item.at } : {}),
      ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
    }
    if (kind === 'dispatch') lastDispatch = event
    if (kind === 'report') lastReport = event
    events.push(event)
  }

  // Dispatch record: attach to the last dispatch row; legacy payloads without
  // that row still get a receipt (use the record's createdAt when present).
  if (detail.dispatch !== undefined && detail.dispatch !== null) {
    if (lastDispatch !== undefined) {
      lastDispatch.dispatch = detail.dispatch
    } else {
      const record = detail.dispatch
      lastDispatch = {
        id: 'dispatch_record',
        kind: 'dispatch',
        text: '',
        ...(record.createdAt !== undefined ? { at: record.createdAt } : {}),
        dispatch: record,
      }
      events.push(lastDispatch)
    }
  }

  // Human edits: merge the timeline row with its `boardEdits` diff when the
  // timestamps match; otherwise keep the diff as its own event.
  const edits = detail.boardEdits ?? []
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index]
    if (edit === undefined) continue
    const matched = edit.at === undefined
      ? undefined
      : events.find(event => event.kind === 'user_edit' && event.at === edit.at && event.edit === undefined)
    if (matched !== undefined) {
      matched.edit = edit
      continue
    }
    events.push({
      id: `edit_${edit.editId ?? String(index)}`,
      kind: 'user_edit',
      text: '',
      ...(edit.at !== undefined ? { at: edit.at } : {}),
      edit,
    })
  }

  // Session cards: attach to the latest timeline row carrying that sessionId
  // (dispatch or session_stop); the primary session may fall back to the last
  // dispatch row. Anything left is one "sessions" block at the end.
  const sessions = detail.sessions ?? []
  const attached = new Set<string>()
  for (const session of sessions) {
    if (session.sessionId === undefined || session.sessionId === '') continue
    let target: TaskFeedEvent | undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]
      if (candidate !== undefined && candidate.sessionId === session.sessionId) {
        target = candidate
        break
      }
    }
    if (target === undefined) continue
    target.sessions = [...(target.sessions ?? []), session]
    attached.add(session.sessionId)
  }
  const primary = task.primarySessionId === undefined || task.primarySessionId === ''
    ? undefined
    : sessions.find(session => session.sessionId === task.primarySessionId)
  if (primary !== undefined && primary.sessionId !== undefined && !attached.has(primary.sessionId) && lastDispatch !== undefined) {
    lastDispatch.sessions = [...(lastDispatch.sessions ?? []), primary]
    attached.add(primary.sessionId)
  }
  const leftovers = sessions.filter(session => session.sessionId === undefined || !attached.has(session.sessionId))

  events.sort((left, right) => (left.at ?? Number.POSITIVE_INFINITY) - (right.at ?? Number.POSITIVE_INFINITY))

  if (leftovers.length > 0) {
    events.push({ id: 'sessions', kind: 'sessions', text: '', sessions: leftovers })
  }
  const acceptance = detail.acceptance ?? []
  const summaryText = detail.reportSummary?.text
  const reportSummary = summaryText === undefined || summaryText === '' ? undefined : summaryText
  if (acceptance.length > 0) {
    if (lastReport !== undefined) {
      lastReport.acceptance = acceptance
      if (reportSummary !== undefined) lastReport.summary = reportSummary
    } else {
      events.push({
        id: 'acceptance',
        kind: 'acceptance',
        text: '',
        acceptance,
        ...(reportSummary !== undefined ? { summary: reportSummary } : {}),
      })
    }
  } else if (reportSummary !== undefined) {
    // 只有 summary、没有验收（如 blocked/no_progress 报告）：仍挂到最后一条 report 行。
    if (lastReport !== undefined) lastReport.summary = reportSummary
    else events.push({ id: 'report_summary', kind: 'report', text: '', summary: reportSummary })
  }
  return events
}

/** Five-step progress shown in the drawer header: 待派发 → 待运行 → 运行中 → 待验收 → 已验收. */
export type TaskStage = 'proposed' | 'queued' | 'running' | 'review' | 'done'
export const TASK_STAGES: readonly TaskStage[] = ['proposed', 'queued', 'running', 'review', 'done']

/** Map the frozen status machine onto the five drawer steps (blocked overlays the running step). */
export function taskStage(status: string | undefined): TaskStage {
  switch (status) {
    case 'draft':
    case 'proposed':
      return 'proposed'
    case 'queued':
      return 'queued'
    case 'running':
    case 'blocked':
      return 'running'
    case 'review':
      return 'review'
    case 'done':
    case 'cancelled':
    case 'archived':
      return 'done'
    default:
      return 'proposed'
  }
}

/** blocked 在「运行中」段叠加受阻标记（不改五段本身）。 */
export function taskStageBlocked(status: string | undefined): boolean {
  return status === 'blocked'
}

/** 取消/归档 = 终止标记（抽屉不再显示后续段为进行中）。 */
export function taskTerminal(status: string | undefined): boolean {
  return status === 'cancelled' || status === 'archived'
}

/** 看板「取消」按钮：任何非终态（done/cancelled/archived 不允许）。 */
export function canCancelTask(task: TaskView): boolean {
  return !['done', 'cancelled', 'archived'].includes(task.status ?? '')
}

/** 卡片依赖 badge 文案数据：waitingFor 有值 = 仍在等待。 */
export function waitingFor(task: TaskView): readonly string[] {
  return Array.isArray(task.waitingFor) ? task.waitingFor : []
}

/** 任务是否有待确认派发卡。 */
export function hasPendingDispatch(task: TaskView, pendingTaskIds: readonly string[] = []): boolean {
  return task.pendingDispatch === true || pendingTaskIds.includes(task.id)
}

/** Evidence tally for the drawer header / acceptance block. */
export interface AcceptanceSummary {  total: number
  /** Rows whose Host state is `evidence_present`. */
  evidence: number
  insufficient: number
}

export function acceptanceSummary(rows: readonly TaskAcceptanceView[] | undefined): AcceptanceSummary {
  const list = rows ?? []
  let evidence = 0
  for (const row of list) {
    if (row.state === 'evidence_present') evidence += 1
  }
  return { total: list.length, evidence, insufficient: list.length - evidence }
}

/**
 * 结论卡默认折叠阈值（字符数）：12.5px 字号、抽屉宽约 460px 时 4 行约 140 字。
 * jsdom/无布局环境量不到 scrollHeight，用字数兜底保证长结论一定出现「展开」。
 */
export const SUMMARY_COLLAPSE_CHARS = 140

/** 摘要是否需要折叠（实测溢出也会折叠，这里只做无布局环境的兜底判定）。 */
export function shouldCollapseSummary(text: string | undefined): boolean {
  return (text ?? '').trim().length > SUMMARY_COLLAPSE_CHARS
}

/** `HH:mm` for feed rows (24-hour, locale-independent shape). */
export function formatClockTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    return ''
  }
}

/** Whether two timestamps fall on the same local calendar day. */
export function sameLocalDay(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined || !Number.isFinite(left) || !Number.isFinite(right)) return false
  const a = new Date(left)
  const b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Day separator label (`11月18日` / `Nov 18`). */
export function formatDayLabel(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleDateString([], { month: 'long', day: 'numeric' })
  } catch {
    return ''
  }
}

/* ---------------------------------------------------------------------------
 * M5 multi-round model
 *
 * A task can be dispatched several times. The detail payload carries
 * `dispatches[]`, `acceptanceHistory[]`, `sessions[].round` and `timeline[].round`;
 * this helper folds them into one section per round so the drawer can render
 * 「用户原话 → 派发原文 → 工作会话 → 报告/验收」 without duplicating joins in JSX.
 * ------------------------------------------------------------------------- */

export interface TaskRoundUserRequest {
  text: string
  at?: number
  source?: 'chat' | 'board'
}

/** One round of a task, assembled from the detail payload. */
export interface TaskRoundView {
  round: number
  isCurrent: boolean
  userRequest?: TaskRoundUserRequest
  dispatch?: TaskDispatchDetailView
  sessions: TaskSessionLinkView[]
  timeline: TaskTimelineView[]
  acceptance: TaskAcceptanceView[]
  reportSummary?: string
  /** 方案 A：本轮报告的材料；空数组 = 无材料。 */
  materials: ReportMaterialView[]
  edits: BoardEditView[]
  startedAt?: number
  endedAt?: number
}

function timelineRoundOf(item: TaskTimelineView, dispatches: readonly TaskDispatchDetailView[], fallback: number): number {
  if (typeof item.round === 'number' && item.round >= 1) return item.round
  const at = item.at ?? 0
  if (item.type === 'created') return 1
  if (item.type === 'continue_request') return fallback + 1
  let chosen = 1
  for (const dispatch of dispatches) {
    const createdAt = dispatch.createdAt ?? 0
    if (createdAt <= at) chosen = dispatch.round ?? chosen
  }
  return chosen
}

/** Deterministic round model used by the drawer. Legacy payloads (no round) collapse to round 1. */
export function buildTaskRounds(task: TaskView, detail: TaskDetailView): TaskRoundView[] {
  const current = Math.max(1, task.round ?? 1)
  const fallbackDispatches = detail.dispatch === undefined || detail.dispatch === null ? [] : [detail.dispatch]
  const dispatches = (detail.dispatches !== undefined && detail.dispatches.length > 0 ? detail.dispatches : fallbackDispatches)
    .filter((dispatch): dispatch is TaskDispatchDetailView => dispatch !== undefined && dispatch !== null)
  const history = detail.acceptanceHistory ?? []
  // A pending continue request has no dispatch yet; render it via `pendingInstruction`,
  // not as a phantom next round with only a continue_request row.
  const timeline = (detail.timeline ?? []).filter(item => item.type !== 'continue_request')
  const sessions = detail.sessions ?? []

  const maxRound = Math.max(
    current,
    1,
    ...dispatches.map((dispatch, index) => dispatch.round ?? index + 1),
    ...history.map((row: TaskAcceptanceRoundView) => row.round ?? 1),
    ...timeline.map(item => timelineRoundOf(item, dispatches, current)),
  )

  const rounds: TaskRoundView[] = []
  for (let round = 1; round <= maxRound; round += 1) {
    const roundDispatches = dispatches.filter((dispatch, index) => (dispatch.round ?? index + 1) === round)
    const dispatch = roundDispatches.length > 0 ? roundDispatches[roundDispatches.length - 1] : undefined
    const roundTimeline = timeline
      .filter(item => timelineRoundOf(item, dispatches, current) === round)
      .sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
    const historyRow = history.find(row => (row.round ?? 1) === round)
    const acceptance = round === current ? (detail.acceptance ?? []) : (historyRow?.items ?? [])
    const reportSummary = round === current ? detail.reportSummary?.text : historyRow?.reportSummary?.text
    const materials = round === current ? (detail.reportMaterials ?? []) : (historyRow?.materials ?? [])
    const roundSessions = sessions.filter(session => (session.round ?? 1) === round)
    const roundEdits = (detail.boardEdits ?? []).filter(edit => {
      const at = edit.at ?? 0
      let chosen = 1
      for (const item of dispatches) {
        const createdAt = item.createdAt ?? 0
        if (createdAt <= at) chosen = item.round ?? chosen
      }
      return chosen === round
    })
    const times = [
      ...(dispatch?.createdAt !== undefined ? [dispatch.createdAt] : []),
      ...roundTimeline.map(item => item.at).filter((at): at is number => typeof at === 'number'),
      ...(historyRow?.at !== undefined ? [historyRow.at] : []),
      ...(historyRow?.reportSummary?.at !== undefined ? [historyRow.reportSummary.at] : []),
      ...(round === current && detail.reportSummary?.at !== undefined ? [detail.reportSummary.at] : []),
    ]
    const userRequest = dispatch?.userRequest !== undefined && dispatch.userRequest.text !== undefined && dispatch.userRequest.text !== ''
      ? {
          text: dispatch.userRequest.text,
          ...(dispatch.userRequest.at !== undefined ? { at: dispatch.userRequest.at } : {}),
          ...(dispatch.userRequest.source !== undefined ? { source: dispatch.userRequest.source } : {}),
        }
      : undefined
    rounds.push({
      round,
      isCurrent: round === current,
      ...(userRequest !== undefined ? { userRequest } : {}),
      ...(dispatch !== undefined ? { dispatch } : {}),
      sessions: roundSessions,
      timeline: roundTimeline,
      acceptance,
      ...(reportSummary !== undefined && reportSummary !== '' ? { reportSummary } : {}),
      materials,
      edits: roundEdits,
      ...(times.length > 0 ? { startedAt: Math.min(...times), endedAt: Math.max(...times) } : {}),
    })
  }
  return rounds
}

/**
 * 依赖图的连通分量（包含自身）：沿 dependsOn 双向（前置 ⇄ 下游）做 BFS。
 *
 * 不是「只走本节点的上下游」：同一张依赖图里，`C 依赖 A 和 B` 时鼠标落在 A 上
 * 也要把兄弟前置 B 一起点亮，否则同一张图会按悬停的节点忽大忽小
 * （用户反馈：悬停 C 高亮 A+B，悬停 A 只高亮 C）。
 */
export function dependencyClosure(tasks: readonly TaskView[], taskId: string): ReadonlySet<string> {
  const neighbors = new Map<string, string[]>()
  const link = (id: string, other: string): void => {
    const list = neighbors.get(id) ?? []
    if (!list.includes(other)) list.push(other)
    neighbors.set(id, list)
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      link(task.id, dep)
      link(dep, task.id)
    }
  }
  const seen = new Set<string>([taskId])
  const queue: string[] = [taskId]
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]
    if (id === undefined) continue
    for (const next of neighbors.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** 每个任务被多少个任务依赖（卡片「下游 N」）。 */
export function downstreamCounts(tasks: readonly TaskView[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) counts.set(dep, (counts.get(dep) ?? 0) + 1)
  }
  return counts
}

/** 本地时区的归档月份 key（YYYY-MM），与 Host 月份导航一致。 */
export function archiveMonthKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** 月份 key → [from, to)：本地自然月，用作 archive 的 from/to。 */
export function archiveMonthBounds(key: string): { from: number; to: number } {
  const [yearRaw, monthRaw] = key.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  return { from: new Date(year, month - 1, 1).getTime(), to: new Date(year, month, 1).getTime() }
}

/** 回收站按「月 → 日」分组；tasks 已按 updatedAt 倒序，保持顺序。 */
export interface ArchiveDayGroup {
  key: string
  at: number
  tasks: TaskView[]
}
export interface ArchiveMonthGroup {
  key: string
  days: ArchiveDayGroup[]
}
export function groupArchiveByMonthDay(tasks: readonly TaskView[]): ArchiveMonthGroup[] {
  const months: ArchiveMonthGroup[] = []
  for (const task of [...tasks].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
    const at = task.updatedAt ?? 0
    const monthKey = archiveMonthKey(at)
    const date = new Date(at)
    const dayKey = `${monthKey}-${String(date.getDate()).padStart(2, '0')}`
    let month = months.find((row) => row.key === monthKey)
    if (month === undefined) {
      month = { key: monthKey, days: [] }
      months.push(month)
    }
    let day = month.days.find((row) => row.key === dayKey)
    if (day === undefined) {
      day = { key: dayKey, at, tasks: [] }
      month.days.push(day)
    }
    day.tasks.push(task)
  }
  return months
}

/**
 * 回收站数量（tab 徽标 / 「全量 N 条」）：counts 是全域权威计数，tasks 只在旧快照
 * 缺 counts 时兜底；两者按状态取 max，避免 cancelled 同时在 counts 与 tasks 中被算两次。
 */
export function archiveCount(input: { counts?: Readonly<Record<string, number | undefined>>; tasks: readonly TaskView[] }): number {
  const counts = input.counts ?? {}
  const archivedInTasks = input.tasks.filter((task) => task.status === 'archived').length
  const cancelledInTasks = input.tasks.filter((task) => task.status === 'cancelled').length
  return Math.max(counts.archived ?? 0, archivedInTasks) + Math.max(counts.cancelled ?? 0, cancelledInTasks)
}

/**
 * 悬停依赖聚焦用的图：只有存在**可见关联**（快照里能找到的同图节点）时才返回连通分量；
 * 无依赖的卡返回 null，避免「淡出全板但没有任何高亮/连线」的空效果。
 */
export function dependencyHighlightChain(tasks: readonly TaskView[], taskId: string): ReadonlySet<string> | null {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  if (!byId.has(taskId)) return null
  const chain = dependencyClosure(tasks, taskId)
  for (const id of chain) {
    if (id !== taskId && byId.has(id)) return chain
  }
  return null
}

/** 卡片在依赖连线覆盖层坐标系里的矩形（相对看板滚动容器）。 */
export interface BoardCardBox {
  left: number
  right: number
  top: number
  bottom: number
}

/** 端点离卡片转角的内缩：卡片圆角 10px，取 12px 让箭头落在直边上而不是圆角上。 */
const DEP_EDGE_CORNER_INSET = 12

/** 把端点位置夹在卡片的某条边上，避开转角；盒子过小时退化为边中点。 */
function clampToSide(value: number, lo: number, hi: number): number {
  const inset = Math.min(DEP_EDGE_CORNER_INSET, (hi - lo) / 2)
  return Math.min(hi - inset, Math.max(lo + inset, value))
}

function formatPathPoint(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/**
 * 依赖连线的路径：两卡之间取**最近的一对边**进出——
 * 纵排（同一列，x 区间重叠）时连上卡的底边与下卡的顶边，跨列时连左右相对的两条竖边；
 * 端点在该边上朝另一张卡的中心投影（按转角内缩夹住），不再一律钉在边的正中，
 * 所以上下错开的两张卡会从相近的两个角出发，曲线更短、也不会绕到卡片外侧。
 */
export function dependencyEdgePath(from: BoardCardBox, to: BoardCardBox): string {
  const fromMidX = (from.left + from.right) / 2
  const fromMidY = (from.top + from.bottom) / 2
  const toMidX = (to.left + to.right) / 2
  const toMidY = (to.top + to.bottom) / 2
  const sameColumn = Math.min(from.right, to.right) > Math.max(from.left, to.left)
  if (sameColumn) {
    const downward = toMidY >= fromMidY
    const sx = clampToSide(toMidX, from.left, from.right)
    const tx = clampToSide(fromMidX, to.left, to.right)
    const sy = downward ? from.bottom : from.top
    const ty = downward ? to.top : to.bottom
    const control = Math.max(10, Math.abs(ty - sy) * 0.42) * (downward ? 1 : -1)
    return `M ${formatPathPoint(sx)} ${formatPathPoint(sy)} C ${formatPathPoint(sx)} ${formatPathPoint(sy + control)}, ${formatPathPoint(tx)} ${formatPathPoint(ty - control)}, ${formatPathPoint(tx)} ${formatPathPoint(ty)}`
  }
  const rightward = toMidX >= fromMidX
  const sx = rightward ? from.right : from.left
  const tx = rightward ? to.left : to.right
  const sy = clampToSide(toMidY, from.top, from.bottom)
  const ty = clampToSide(fromMidY, to.top, to.bottom)
  const control = Math.max(30, Math.abs(tx - sx) * 0.42) * (rightward ? 1 : -1)
  return `M ${formatPathPoint(sx)} ${formatPathPoint(sy)} C ${formatPathPoint(sx + control)} ${formatPathPoint(sy)}, ${formatPathPoint(tx - control)} ${formatPathPoint(ty)}, ${formatPathPoint(tx)} ${formatPathPoint(ty)}`
}

/** 看板列宽：默认六列等分；拖动只改相邻两列的 fr 比例。 */
export const BOARD_COLUMN_COUNT = 6
export const BOARD_COLUMN_MIN_PX = 180
export const BOARD_COLUMN_FR_STORAGE_KEY = 'dshc:board-column-fr:v1'
export const DEFAULT_BOARD_COLUMN_FR: readonly number[] = [1, 1, 1, 1, 1, 1]

/** localStorage 读回的列宽必须是 6 个正数，否则回落默认等分。 */
export function normalizeBoardColumnFr(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== BOARD_COLUMN_COUNT) return null
  const numbers: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) return null
    numbers.push(item)
  }
  return numbers
}

/**
 * 拖动第 index 与 index+1 列之间的分隔条：按 px 位移换算成 fr，总和保持不变，
 * 两列都不低于 minPx（换算成 minFr）；拖过头时反向补偿，避免总宽漂移。
 */
export function resizeBoardColumnFr(
  fr: readonly number[],
  index: number,
  deltaPx: number,
  availablePx: number,
  minPx = BOARD_COLUMN_MIN_PX,
): number[] {
  const next = [...fr]
  if (index < 0 || index >= next.length - 1 || availablePx <= 0) return next
  const sum = next.reduce((total, value) => total + value, 0)
  if (sum <= 0) return next
  const minFr = (minPx * sum) / availablePx
  const deltaFr = (deltaPx * sum) / availablePx
  let left = (next[index] ?? 1) + deltaFr
  let right = (next[index + 1] ?? 1) - deltaFr
  if (left < minFr) {
    right -= minFr - left
    left = minFr
  }
  if (right < minFr) {
    left -= minFr - right
    right = minFr
  }
  next[index] = Math.max(minFr, left)
  next[index + 1] = Math.max(minFr, right)
  // 极端情况下（两列都无法再压缩）保持总和不变。
  const drift = sum - next.reduce((total, value) => total + value, 0)
  next[index] = (next[index] ?? minFr) + drift
  return next
}
