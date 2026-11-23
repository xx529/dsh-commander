// 会话查询（task-query-design §10）：必须指定工作区（id/名称/路径/cwd 子目录），只出根会话。
import type { CordisContext } from '../dsh-types.ts'
import type { StoreSet } from '../store/index.ts'
import type { WorkspaceDirectoryEntry } from '../dispatch/candidates.ts'
import { collectWorkspaceDirectory, collectWorkspaceSessions, resolveWorkspaceReference } from '../dispatch/candidates.ts'
import { cwdBelongsToWorkspace } from '../session/session-records.ts'
import { parseTimeBound } from './time-input.ts'
import { TASK_QUERY_OFFSET_MAX, TASK_QUERY_LIMIT_DEFAULT, TASK_QUERY_LIMIT_MAX } from './tasks.ts'

export const SESSION_QUERY_TEXT_MAX = 200
/** 单工作区扫描上限（与 dispatch 候选一致的数量级；total 是「扫描到的根会话数」）。 */
export const SESSION_SCAN_MAX = 1_000

export interface SessionQueryFilter {
  q?: string
  includeArchived: boolean
  since?: number
  until?: number
  limit: number
  offset: number
}

export interface SessionQueryRow {
  sessionId: string
  title: string
  createdAt: number
  lastActiveAt: number
  ageMinutes: number
  archived: boolean
  model?: string
  agentPreset?: string
  contextUsage?: number
}

export type SessionQueryResult =
  | {
      ok: true
      workspace: { id: string; name: string }
      total: number
      offset: number
      limit: number
      returned: number
      hasMore: boolean
      nextOffset?: number
      sessions: SessionQueryRow[]
    }
  | { ok: false; code: 'invalid_request' | 'unknown_workspace'; message: string }

export type SessionQueryParse = { ok: true; workspaceId: string; filter: SessionQueryFilter } | { ok: false; code: 'invalid_request'; message: string }

const PARAMETERS = ['workspaceId', 'q', 'includeArchived', 'since', 'until', 'limit', 'offset'] as const
const reject = (message: string): SessionQueryParse => ({ ok: false, code: 'invalid_request', message })

/** 解析 `commander_session_list` 入参：`workspaceId` 必填（空参数查询不允许）。 */
export function parseSessionQueryArgs(args: Record<string, unknown>): SessionQueryParse {
  for (const key of Object.keys(args)) {
    if (!(PARAMETERS as readonly string[]).includes(key)) return reject(`unknown parameter '${key}'；支持 ${PARAMETERS.join('/')}`)
  }
  const rawWorkspace = args.workspaceId
  if (typeof rawWorkspace !== 'string' || rawWorkspace.trim() === '') {
    return reject('workspaceId is required（工作区 id / 名称 / 路径 / cwd 子目录；不支持空参数查询）')
  }
  let q: string | undefined
  if (args.q !== undefined) {
    if (typeof args.q !== 'string') return reject('q must be a string')
    const text = args.q.trim()
    if (text.length > SESSION_QUERY_TEXT_MAX) return reject(`q exceeds ${SESSION_QUERY_TEXT_MAX} characters`)
    q = text === '' ? undefined : text.toLowerCase()
  }
  let includeArchived = false
  if (args.includeArchived !== undefined) {
    if (typeof args.includeArchived !== 'boolean') return reject('includeArchived must be a boolean')
    includeArchived = args.includeArchived
  }
  const sinceResult = parseTimeBound(args.since, 'from')
  if (sinceResult !== undefined && !sinceResult.ok) return reject(sinceResult.message)
  const untilResult = parseTimeBound(args.until, 'to')
  if (untilResult !== undefined && !untilResult.ok) return reject(untilResult.message)
  const since = sinceResult?.ok === true ? sinceResult.value : undefined
  const until = untilResult?.ok === true ? untilResult.value : undefined
  if (since !== undefined && until !== undefined && since >= until) return reject('since 必须早于 until（until 只写日期时表示「含当天全天」）')
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
    workspaceId: rawWorkspace.trim(),
    filter: {
      ...(q !== undefined ? { q } : {}),
      includeArchived,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      limit,
      offset,
    },
  }
}

const ambiguous = (reference: string, candidates: readonly WorkspaceDirectoryEntry[]): SessionQueryResult => ({
  ok: false,
  code: 'invalid_request',
  message: `workspace "${reference}" 匹配到多个已启用工作区：${candidates.map((entry) => entry.id).join(', ')}；请用 id 精确指定`,
})

/** 只在已启用工作区里解析：id/名称/路径（resolveWorkspaceReference）→ 绝对路径按 cwd 归属（最长前缀）。 */
function resolveEnabledWorkspace(
  directory: readonly WorkspaceDirectoryEntry[],
  reference: string,
): { ok: true; workspace: WorkspaceDirectoryEntry } | { ok: false; result: SessionQueryResult } {
  const enabled = directory.filter((entry) => entry.allowed === true)
  const resolution = resolveWorkspaceReference(enabled, reference)
  if (resolution.status === 'resolved') return { ok: true, workspace: resolution.workspace }
  if (resolution.status === 'ambiguous') return { ok: false, result: ambiguous(reference, resolution.candidates) }
  const byCwd = enabled.filter((entry) => cwdBelongsToWorkspace(reference, entry.path))
  if (byCwd.length === 1) return { ok: true, workspace: byCwd[0] as WorkspaceDirectoryEntry }
  if (byCwd.length > 1) {
    const longest = Math.max(...byCwd.map((entry) => entry.path.length))
    const best = byCwd.filter((entry) => entry.path.length === longest)
    if (best.length === 1) return { ok: true, workspace: best[0] as WorkspaceDirectoryEntry }
    return { ok: false, result: ambiguous(reference, best) }
  }
  return {
    ok: false,
    result: {
      ok: false,
      code: 'unknown_workspace',
      message: `workspace "${reference}" 不存在或未启用；请先调 commander_workspace_list 取已启用工作区`,
    },
  }
}

/**
 * 查询某工作区的根会话（collectWorkspaceSessions 已排除指挥官/子代理/teammate 与归档）。
 * 结果按 lastActiveAt 倒序、id 升序分页。
 */
export async function querySessions(input: {
  ctx: CordisContext
  stores: StoreSet
  workspaceRef: string
  filter: SessionQueryFilter
  now: number
}): Promise<SessionQueryResult> {
  const directory = await collectWorkspaceDirectory({ ctx: input.ctx, stores: input.stores })
  const resolved = resolveEnabledWorkspace(directory, input.workspaceRef)
  if (!resolved.ok) return resolved.result
  const workspace = resolved.workspace
  const collected = await collectWorkspaceSessions({
    ctx: input.ctx,
    stores: input.stores,
    workspaceId: workspace.id,
    includeArchived: input.filter.includeArchived,
    maxSessions: SESSION_SCAN_MAX,
  })
  if (collected.status === 'not_found') {
    return { ok: false, code: 'unknown_workspace', message: `workspace "${input.workspaceRef}" 不存在或未启用` }
  }
  const filtered = collected.sessions.filter((session) => {
    if (input.filter.q !== undefined && !session.title.toLowerCase().includes(input.filter.q)) return false
    if (input.filter.since !== undefined && session.lastActiveAt < input.filter.since) return false
    if (input.filter.until !== undefined && session.lastActiveAt >= input.filter.until) return false
    return true
  })
  const sorted = [...filtered].sort((left, right) => right.lastActiveAt - left.lastActiveAt || left.id.localeCompare(right.id))
  const page = sorted.slice(input.filter.offset, input.filter.offset + input.filter.limit)
  const nextOffset = input.filter.offset + page.length
  const sessions: SessionQueryRow[] = page.map((session) => ({
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    ageMinutes: Math.max(0, Math.floor((input.now - session.lastActiveAt) / 60_000)),
    archived: session.archived,
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.agentPreset !== undefined ? { agentPreset: session.agentPreset } : {}),
    ...(session.contextUsage !== undefined ? { contextUsage: session.contextUsage } : {}),
  }))
  return {
    ok: true,
    workspace: { id: workspace.id, name: workspace.name },
    total: sorted.length,
    offset: input.filter.offset,
    limit: input.filter.limit,
    returned: sessions.length,
    hasMore: nextOffset < sorted.length,
    ...(nextOffset < sorted.length ? { nextOffset } : {}),
    sessions,
  }
}
