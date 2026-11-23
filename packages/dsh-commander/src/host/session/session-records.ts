// 真实 @deepseek-ai/dsh-session-query 记录归一（M1R/live 绑定修复）：
// listSessions() → SessionRecord[] = { header: SessionHeader, live, persisted, formatStatus? }，
// id/cwd/createdAt/parent 都在 header；title 必须用 readTitleSnapshots(ids)（对冷会话有效）。
import type { CordisContext, SessionEventLike, SessionLike, SessionsQueryService } from '../dsh-types.ts'

export interface NormalizedSession {
  id: string
  cwd?: string
  createdAt: number
  agentPreset?: string
  /** 子代理/子会话（header.origin==='subagent' 或 delegationDepth>0）；parentSession 单独存在不判子会话（官方注释）。 */
  isChild: boolean
  /** 父会话 id（header.parentSession，字符串或 {id}）：teammate/子会话的根判据，不改变 isChild 语义。 */
  parentSessionId?: string
  live: boolean
  persisted: boolean
  archived: boolean
  title: string
  /** 标题快照 updatedAt（无则 0）。 */
  titleUpdatedAt: number
  model?: string
  contextUsage?: number
}

interface HeaderLike {
  id?: unknown
  cwd?: unknown
  createdAt?: unknown
  parentSession?: unknown
  origin?: unknown
  delegationDepth?: unknown
  agentPreset?: unknown
}

interface RecordLike {
  header?: unknown
  live?: unknown
  persisted?: unknown
  // 兼容旧 fake/flat 形状（M0/M1 测试与旧宿主）
  id?: unknown
  sessionId?: unknown
  workspaceId?: unknown
  cwd?: unknown
  title?: unknown
  updatedAt?: unknown
  lastActiveAt?: unknown
  archived?: unknown
  model?: unknown
  contextUsage?: unknown
  agentPreset?: unknown
  parentSessionId?: unknown
  parentId?: unknown
  subagentOf?: unknown
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** header.parentSession 兼容字符串与 {id} 两种形状。 */
function parentSessionIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (isRecord(value)) return asString((value as { id?: unknown }).id)
  return undefined
}
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 由 SessionHeader（真实 header 或 readTitleSnapshots 的 value.session）归一（无 title，稍后补）。 */
export function normalizeSessionHeader(headerInput: unknown, extra: { live?: boolean; persisted?: boolean } = {}): NormalizedSession | undefined {
  if (!isRecord(headerInput)) return undefined
  const header = headerInput as HeaderLike
  const id = asString(header.id)
  if (id === undefined) return undefined
  const cwd = asString(header.cwd)
  const createdAt = asNumber(header.createdAt) ?? 0
  const agentPreset = asString(header.agentPreset)
  const isChild = header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
  const parentSessionId = parentSessionIdOf(header.parentSession)
  return {
    id,
    ...(cwd !== undefined ? { cwd } : {}),
    createdAt,
    ...(agentPreset !== undefined ? { agentPreset } : {}),
    isChild,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    live: extra.live === true,
    persisted: extra.persisted === true,
    archived: false,
    title: '',
    titleUpdatedAt: 0,
  }
}

/** 把真实 SessionRecord（header 包裹）或旧扁平 entry 归一为统一形状；无效返回 undefined。 */
export function normalizeSessionRecord(item: unknown): NormalizedSession | undefined {
  if (!isRecord(item)) return undefined
  const record = item as RecordLike
  const header = isRecord(record.header) ? (record.header as HeaderLike) : undefined
  const id = asString(header?.id) ?? asString(record.id) ?? asString(record.sessionId)
  if (id === undefined) return undefined
  const cwd = asString(header?.cwd) ?? asString(record.cwd)
  const createdAt = asNumber(header?.createdAt) ?? asNumber(record.updatedAt) ?? asNumber(record.lastActiveAt) ?? 0
  const agentPreset = asString(header?.agentPreset) ?? asString(record.agentPreset)
  const parentSessionId = parentSessionIdOf(header?.parentSession) ?? asString(record.parentSessionId) ?? asString(record.parentId) ?? asString(record.subagentOf)
  const isChild = header?.origin === 'subagent' || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) ||
    asString(record.parentSessionId) !== undefined || asString(record.parentId) !== undefined || asString(record.subagentOf) !== undefined
  const rawModel = record.model
  const model = typeof rawModel === 'string' ? rawModel : isRecord(rawModel) && typeof rawModel.model === 'string' ? rawModel.model : undefined
  const contextUsage = typeof record.contextUsage === 'number' ? record.contextUsage : undefined
  return {
    id,
    ...(cwd !== undefined ? { cwd } : {}),
    createdAt,
    ...(agentPreset !== undefined ? { agentPreset } : {}),
    isChild,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    live: record.live === true,
    persisted: record.persisted === true,
    archived: record.archived === true,
    title: asString(record.title) ?? '',
    titleUpdatedAt: 0,
    ...(model !== undefined ? { model } : {}),
    ...(contextUsage !== undefined ? { contextUsage } : {}),
  }
}

/** 根会话：非子代理/子会话、无父会话指针、且不是指挥官会话本身（task-query-design D9）。 */
export function isRootSession(
  session: Pick<NormalizedSession, 'id' | 'isChild' | 'parentSessionId'>,
  commanderSessionId?: string,
): boolean {
  if (commanderSessionId !== undefined && session.id === commanderSessionId) return false
  if (session.isChild) return false
  return session.parentSessionId === undefined
}

export interface TitleLookup {
  title: string
  updatedAt: number
}

/**
 * 分块并行 readTitleSnapshots：dsh-session-query 的 projectMany 每调用内部只有
 * `persistedReadConcurrency` 个 worker（默认较小）；大 limit 时串行读冷日志会线性变慢。
 * 纯并发读（不缓存、不改语义），chunk 无重叠；整批失败由调用方降级。
 */
async function readTitleSnapshotResults(ctx: CordisContext, ids: readonly string[]): Promise<unknown[]> {
  const query = ctx.get('sessionQuery') as SessionsQueryService | undefined
  if (query?.readTitleSnapshots === undefined) return []
  const unique = [...new Set(ids)]
  if (unique.length <= 8) {
    try {
      return (await query.readTitleSnapshots(unique)) as unknown[]
    } catch {
      return []
    }
  }
  const configured = Number(process.env.COMMANDER_SESSION_TITLE_CONCURRENCY)
  const concurrency = Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), 8) : 4
  const chunkSize = Math.ceil(unique.length / concurrency)
  const chunks: string[][] = []
  for (let index = 0; index < unique.length; index += chunkSize) chunks.push(unique.slice(index, index + chunkSize))
  const settled = await Promise.allSettled(chunks.map((chunk) => query.readTitleSnapshots?.(chunk) as Promise<unknown[]>))
  const merged: unknown[] = []
  let anyFulfilled = false
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue
    anyFulfilled = true
    if (Array.isArray(item.value)) merged.push(...item.value)
  }
  return anyFulfilled ? merged : []
}

/**
 * 批量读标题快照（真实 readTitleSnapshots；冷会话有效；大列表分块并行）：
 * - 单条 rejected 隔离；整批抛错/服务缺失 → 返回空 map（不整批失败，调用方降级 title=''）。
 */
export async function readSessionTitles(ctx: CordisContext, ids: string[]): Promise<Map<string, TitleLookup>> {
  const titles = new Map<string, TitleLookup>()
  if (ids.length === 0) return titles
  const query = ctx.get('sessionQuery') as SessionsQueryService | undefined
  if (query?.readTitleSnapshots === undefined) return titles
  try {
    const results = await readTitleSnapshotResults(ctx, ids)
    for (const result of Array.isArray(results) ? results : []) {
      if (!isRecord(result) || result.status !== 'fulfilled') continue
      const sessionId = asString(result.sessionId)
      if (sessionId === undefined) continue
      const value = result.value as { title?: unknown } | undefined
      const title = isRecord(value?.title) ? asString(value.title.title) : undefined
      const updatedAt = isRecord(value?.title) ? asNumber(value.title.updatedAt) ?? 0 : 0
      if (title !== undefined) titles.set(sessionId, { title, updatedAt })
      else titles.set(sessionId, { title: '', updatedAt })
    }
  } catch {
    return new Map()
  }
  return titles
}

/**
 * 按 id 批量读取会话 header + 标题（真实 readTitleSnapshots：一次调用同时返回 header/title，冷会话有效）。
 * 性能：只读传入 ids（不再全量 listSessions）；整批失败返回空 Map，调用方可降级为 bare entries。
 */
export async function readSessionsByIds(ctx: CordisContext, ids: readonly string[]): Promise<Map<string, NormalizedSession>> {
  const result = new Map<string, NormalizedSession>()
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))].slice(0, 1_000)
  if (unique.length === 0) return result
  const query = ctx.get('sessionQuery') as SessionsQueryService | undefined
  if (query?.readTitleSnapshots === undefined) return result
  try {
    const snapshots = await readTitleSnapshotResults(ctx, unique)
    for (const item of Array.isArray(snapshots) ? snapshots : []) {
      if (!isRecord(item) || item.status !== 'fulfilled') continue
      const sessionId = asString(item.sessionId)
      if (sessionId === undefined) continue
      const value = item.value as { session?: unknown; title?: unknown } | undefined
      const session = normalizeSessionHeader(value?.session)
      if (session === undefined) continue
      const title = isRecord(value?.title) ? asString(value.title.title) : undefined
      const updatedAt = isRecord(value?.title) ? asNumber(value.title.updatedAt) ?? 0 : 0
      if (title !== undefined) session.title = title
      session.titleUpdatedAt = updatedAt
      result.set(sessionId, session)
    }
  } catch {
    return new Map()
  }
  return result
}

export interface ListedSessions {
  sessions: NormalizedSession[]
  /** 是否来自 sessionQuery（false = 仅 registry.sessionIds 兜底）。 */
  fromQuery: boolean
}

/** 列全部逻辑会话（sessionQuery.listSessions + readTitleSnapshots）；query 不可用/为空时返回空（调用方自行兜底 registry）。 */
export async function listNormalizedSessions(ctx: CordisContext, options: { titleIds?: readonly string[] } = {}): Promise<ListedSessions> {
  const query = ctx.get('sessionQuery') as SessionsQueryService | undefined
  if (query?.listSessions === undefined) return { sessions: [], fromQuery: false }
  let listed: unknown[] = []
  try {
    listed = (await query.listSessions()) as unknown[]
  } catch {
    return { sessions: [], fromQuery: false }
  }
  const sessions: NormalizedSession[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(listed) ? listed : []) {
    const normalized = normalizeSessionRecord(item)
    if (normalized === undefined || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    sessions.push(normalized)
  }
  if (sessions.length === 0) return { sessions, fromQuery: false }
  // 性能护栏：默认不读标题；调用方只对“目标工作区匹配 ids”传 titleIds（避免全量 O(N) 日志读取）。
  const titleIds = options.titleIds !== undefined ? [...options.titleIds] : []
  if (titleIds.length > 0) {
    const titles = await readSessionTitles(ctx, titleIds)
    for (const session of sessions) {
      const found = titles.get(session.id)
      if (found !== undefined) {
        session.title = found.title
        session.titleUpdatedAt = found.updatedAt
      }
    }
  }
  return { sessions, fromQuery: true }
}

/** cwd 是否属于工作区 path（精确或子目录；path 为空不匹配）。 */
export function cwdBelongsToWorkspace(cwd: string | undefined, workspacePath: string): boolean {
  if (cwd === undefined || workspacePath === '') return false
  const base = workspacePath.replace(/[\\/]+$/, '')
  if (base === '') return false
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`)
}

/** 从 工作区列表 + sessionIds 归属推断会话的工作区（多个匹配由调用方处理）。 */
export function matchSessionWorkspaces(
  session: NormalizedSession,
  workspaces: Array<{ id: string; path: string; sessionIds?: string[] }>,
): Array<{ id: string; path: string }> {
  return workspaces.filter((workspace) => (workspace.sessionIds ?? []).includes(session.id) || cwdBelongsToWorkspace(session.cwd, workspace.path))
}

// ---------------------------------------------------------------- 会话事件读取
// DSH 的 `sessions` 服务返回 live `Session`（只有 `snapshotEvents()`，没有 `events` 字段），
// 直接读 `session.events` 恒为空数组（2026-11-18 turn/end 注入「本轮无文本回复」的根因）。
// 官方读法是 `ctx.sessionQuery.readSession()`：live 优先、冷会话走持久化，返回同一观察点的完整事件克隆。

/** 会话是否仍 live（内存里还挂着 Session 对象）；用于识别重启/停止后残留的 `running` 记录。 */
export async function isSessionLive(ctx: CordisContext, sessionId: string): Promise<boolean> {
  if (sessionId === '') return false
  try {
    const sessions = ctx.get('sessions') as { get?: (id: string) => Promise<SessionLike | undefined> | SessionLike | undefined } | undefined
    const live = await sessions?.get?.(sessionId)
    return live !== undefined && live !== null
  } catch {
    return false
  }
}

/** 读某会话的完整事件日志；任一步失败回退下一步，全部失败返回空数组。 */
export async function readSessionEvents(ctx: CordisContext, sessionId: string): Promise<SessionEventLike[]> {
  if (sessionId === '') return []
  let query: SessionsQueryService | undefined
  try {
    query = ctx.get('sessionQuery') as SessionsQueryService | undefined
  } catch {
    query = undefined
  }
  if (query?.readSession !== undefined) {
    try {
      const snapshot = await query.readSession(sessionId)
      if (Array.isArray(snapshot?.events)) return snapshot.events
    } catch {
      // 回放校验失败/冷会话不可读：回退 live
    }
  }
  try {
    const sessions = ctx.get('sessions') as { get?: (id: string) => Promise<SessionLike | undefined> | SessionLike | undefined } | undefined
    const session = await sessions?.get?.(sessionId)
    if (Array.isArray(session?.events)) return session.events
    if (typeof session?.snapshotEvents === 'function') return [...session.snapshotEvents()]
  } catch {
    // ignore：注入与报告校验都按空事件降级
  }
  return []
}
