// 任务查询（task-query-design §3/§5/§6）：参数校验 + 过滤/计数/分页 + 列表行投影。
// 纯函数（无 IO）；时间解析在 time-input.ts，六列映射在 board-columns.ts。
import { TASK_STATUSES, type Priority, type TaskRecord, type TaskStatus } from '../schema.ts'
import type { TaskLookup } from '../tasks/dependencies.ts'
import { dependenciesMet, waitingFor } from '../tasks/dependencies.ts'
import { taskIsStale } from '../board/service.ts'
import { clipLine } from '../rotation/brief.ts'
import { HOST_COLUMN_IDS, HOST_TRASH_STATUSES, hostBoardColumnOf } from './board-columns.ts'
import { parseTimeBound } from './time-input.ts'

export const TASK_QUERY_LIMIT_DEFAULT = 20
export const TASK_QUERY_LIMIT_MAX = 100
export const TASK_QUERY_OFFSET_MAX = 10_000
export const TASK_QUERY_TOKENS_MAX = 8
export const TASK_QUERY_TEXT_MAX = 200
export const TASK_BLOCK_REASON_CHARS = 200
export const TASK_TITLE_CHARS = 60

export type TaskSearchField = 'title' | 'goal' | 'reportSummary'
export const TASK_SEARCH_FIELDS: readonly TaskSearchField[] = ['title', 'goal', 'reportSummary']
export type TaskTimeField = 'created' | 'updated' | 'activity'
export const TASK_TIME_FIELDS: readonly TaskTimeField[] = ['created', 'updated', 'activity']

/** 活跃 7 状态（默认 scope，不含回收站）。 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter((status) => status !== 'archived' && status !== 'cancelled')

export interface TaskQueryFilter {
  statuses?: readonly TaskStatus[]
  includeArchived: boolean
  tokens: readonly string[]
  searchIn: readonly TaskSearchField[]
  timeField: TaskTimeField
  since?: number
  until?: number
  limit: number
  offset: number
}

export type TaskQueryParse = { ok: true; filter: TaskQueryFilter } | { ok: false; code: 'invalid_request'; message: string }

const QUERY_PARAMETERS = ['statuses', 'includeArchived', 'q', 'searchIn', 'timeField', 'since', 'until', 'limit', 'offset'] as const
const reject = (message: string): TaskQueryParse => ({ ok: false, code: 'invalid_request', message })

/** 解析 `commander_task_list` 入参（未知参数显式拒绝；旧 `sort`/`workspaces` 不会被静默忽略）。 */
export function parseTaskQueryArgs(args: Record<string, unknown>): TaskQueryParse {
  for (const key of Object.keys(args)) {
    if (!(QUERY_PARAMETERS as readonly string[]).includes(key)) {
      return reject(`unknown parameter '${key}'；支持 ${QUERY_PARAMETERS.join('/')}`)
    }
    if (args[key] === undefined) continue
  }

  let statuses: TaskStatus[] | undefined
  if (args.statuses !== undefined) {
    if (!Array.isArray(args.statuses)) return reject('statuses must be an array of task statuses')
    const collected: TaskStatus[] = []
    for (const item of args.statuses) {
      if (typeof item !== 'string' || !(TASK_STATUSES as readonly string[]).includes(item)) {
        return reject(`invalid status '${String(item)}'；合法值：${TASK_STATUSES.join('|')}`)
      }
      if (!collected.includes(item as TaskStatus)) collected.push(item as TaskStatus)
    }
    if (collected.length > 0) statuses = collected
  }

  let includeArchived = false
  if (args.includeArchived !== undefined) {
    if (typeof args.includeArchived !== 'boolean') return reject('includeArchived must be a boolean')
    includeArchived = args.includeArchived
  }

  let tokens: string[] = []
  if (args.q !== undefined) {
    if (typeof args.q !== 'string') return reject('q must be a string')
    const text = args.q.trim()
    if (text.length > TASK_QUERY_TEXT_MAX) return reject(`q exceeds ${TASK_QUERY_TEXT_MAX} characters`)
    if (text !== '') {
      tokens = text.toLowerCase().split(/\s+/).filter((token) => token !== '')
      if (tokens.length > TASK_QUERY_TOKENS_MAX) return reject(`q supports at most ${TASK_QUERY_TOKENS_MAX} tokens`)
    }
  }

  let searchIn: TaskSearchField[] = ['title']
  if (args.searchIn !== undefined) {
    if (!Array.isArray(args.searchIn)) return reject(`searchIn must be an array of ${TASK_SEARCH_FIELDS.join('|')}`)
    const collected: TaskSearchField[] = []
    for (const item of args.searchIn) {
      if (typeof item !== 'string' || !(TASK_SEARCH_FIELDS as readonly string[]).includes(item)) {
        return reject(`invalid searchIn '${String(item)}'；合法值：${TASK_SEARCH_FIELDS.join('|')}`)
      }
      if (!collected.includes(item as TaskSearchField)) collected.push(item as TaskSearchField)
    }
    if (collected.length > 0) searchIn = collected
  }

  let timeField: TaskTimeField = 'created'
  if (args.timeField !== undefined) {
    if (typeof args.timeField !== 'string' || !(TASK_TIME_FIELDS as readonly string[]).includes(args.timeField)) {
      return reject(`invalid timeField '${String(args.timeField)}'；合法值：${TASK_TIME_FIELDS.join('|')}`)
    }
    timeField = args.timeField as TaskTimeField
  }

  const sinceResult = parseTimeBound(args.since, 'from')
  if (sinceResult !== undefined && !sinceResult.ok) return reject(sinceResult.message)
  const untilResult = parseTimeBound(args.until, 'to')
  if (untilResult !== undefined && !untilResult.ok) return reject(untilResult.message)
  const since = sinceResult?.ok === true ? sinceResult.value : undefined
  const until = untilResult?.ok === true ? untilResult.value : undefined
  if (since !== undefined && until !== undefined && since >= until) {
    return reject('since 必须早于 until（until 只写日期时表示「含当天全天」）')
  }

  let limit = TASK_QUERY_LIMIT_DEFAULT
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > TASK_QUERY_LIMIT_MAX) {
      return reject(`limit must be an integer in 1..${TASK_QUERY_LIMIT_MAX}`)
    }
    limit = args.limit
  }
  let offset = 0
  if (args.offset !== undefined) {
    if (typeof args.offset !== 'number' || !Number.isInteger(args.offset) || args.offset < 0 || args.offset > TASK_QUERY_OFFSET_MAX) {
      return reject(`offset must be an integer in 0..${TASK_QUERY_OFFSET_MAX}`)
    }
    offset = args.offset
  }

  return {
    ok: true,
    filter: {
      ...(statuses !== undefined ? { statuses } : {}),
      includeArchived,
      tokens,
      searchIn,
      timeField,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      limit,
      offset,
    },
  }
}

export interface TaskQueryResult {
  total: number
  counts: Record<string, number>
  columns: Record<string, number>
  /** 分页后的任务（未投影行字段）。 */
  tasks: TaskRecord[]
  hasMore: boolean
  nextOffset?: number
}

const scopeOf = (filter: TaskQueryFilter): TaskStatus[] =>
  filter.statuses !== undefined ? [...filter.statuses] : filter.includeArchived ? [...TASK_STATUSES] : [...ACTIVE_TASK_STATUSES]

const timeValueOf = (task: TaskRecord, field: TaskTimeField): number =>
  field === 'created' ? task.createdAt : field === 'updated' ? task.updatedAt : task.lastActivityAt

const haystacks = (task: TaskRecord): Record<TaskSearchField, string> => ({
  title: task.title.toLowerCase(),
  goal: task.goal.toLowerCase(),
  reportSummary: (task.reportSummary?.text ?? '').toLowerCase(),
})

/** 过滤 → 计数 → 排序（createdAt 倒序, id 升序）→ 分页。 */
export function queryTasks(input: { tasks: readonly TaskRecord[]; filter: TaskQueryFilter; lookup: TaskLookup }): TaskQueryResult {
  const { filter } = input
  const scope = scopeOf(filter)
  const scopeSet = new Set(scope)
  const matchesText = (task: TaskRecord): boolean => {
    if (filter.tokens.length === 0) return true
    const text = haystacks(task)
    return filter.tokens.every((token) => filter.searchIn.some((field) => text[field].includes(token)))
  }

  const matched: TaskRecord[] = []
  for (const task of input.tasks) {
    if (!scopeSet.has(task.status)) continue
    if (filter.since !== undefined || filter.until !== undefined) {
      const at = timeValueOf(task, filter.timeField)
      if (filter.since !== undefined && at < filter.since) continue
      if (filter.until !== undefined && at >= filter.until) continue
    }
    if (!matchesText(task)) continue
    matched.push(task)
  }

  const counts: Record<string, number> = {}
  for (const status of scope) counts[status] = 0
  for (const task of matched) counts[task.status] = (counts[task.status] ?? 0) + 1

  const columns: Record<string, number> = {}
  for (const column of HOST_COLUMN_IDS) {
    const statuses = column === 'trash' ? HOST_TRASH_STATUSES : columnStatuses(column)
    if (statuses.some((status) => scopeSet.has(status as TaskStatus))) columns[column] = 0
  }
  for (const task of matched) {
    const column = hostBoardColumnOf(task.status)
    if (column !== 'unknown') columns[column] = (columns[column] ?? 0) + 1
  }

  const sorted = [...matched].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  const page = sorted.slice(filter.offset, filter.offset + filter.limit)
  const nextOffset = filter.offset + page.length
  return {
    total: sorted.length,
    counts,
    columns,
    tasks: page,
    hasMore: nextOffset < sorted.length,
    ...(nextOffset < sorted.length ? { nextOffset } : {}),
  }
}

const COLUMN_STATUSES: Record<string, readonly string[]> = {
  proposed: ['draft', 'proposed'],
  queued: ['queued'],
  running: ['running'],
  blocked: ['blocked'],
  review: ['review'],
  done: ['done'],
}

function columnStatuses(column: string): readonly string[] {
  return COLUMN_STATUSES[column] ?? []
}

export interface TaskListRow {
  id: string
  title: string
  status: TaskStatus
  column: string
  priority: Priority
  workspaceId: string
  workspaceName: string
  version: number
  round: number
  dispatchable: boolean
  waitingFor?: string[]
  blockReason?: string
  acceptanceCount: number
  stale: boolean
  createdAt: number
  updatedAt: number
  ageMinutes: number
  primarySessionId?: string
  pendingInstruction: boolean
}

/** 列表行投影：拿到一行即可决定派发/续派/打开会话，不需要再 `commander_task_get`。 */
export function buildTaskRow(input: {
  task: TaskRecord
  now: number
  lookup: TaskLookup
  workspaceNameById: ReadonlyMap<string, string>
}): TaskListRow {
  const { task, now, lookup } = input
  const waiting = waitingFor(task, lookup)
  const dispatchableStatus = task.status === 'draft' || task.status === 'proposed' || task.status === 'review'
  const blockReason = task.status === 'blocked' && task.block?.reason !== undefined && task.block.reason.trim() !== ''
    ? clipLine(task.block.reason, TASK_BLOCK_REASON_CHARS)
    : undefined
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    column: hostBoardColumnOf(task.status),
    priority: task.priority,
    workspaceId: task.workspaceId,
    workspaceName: input.workspaceNameById.get(task.workspaceId) ?? task.workspaceId,
    version: task.version,
    round: task.round ?? 1,
    dispatchable: dispatchableStatus && dependenciesMet(task, lookup),
    ...(waiting.length > 0 ? { waitingFor: waiting } : {}),
    ...(blockReason !== undefined ? { blockReason } : {}),
    acceptanceCount: task.acceptance.length,
    stale: taskIsStale(task, now),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ageMinutes: Math.max(0, Math.floor((now - task.updatedAt) / 60_000)),
    ...(task.primarySessionId !== undefined ? { primarySessionId: task.primarySessionId } : {}),
    pendingInstruction: task.pendingInstruction !== undefined,
  }
}

