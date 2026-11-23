// 候选构造：allowed 工作区 + 全部非归档会话（不按时间/Top-K 召回）；确认卡候选 ≤8（recommendation 第一）。
// 契约：ARCHITECTURE §5.2/§5.5、m1-contract-patch §1.3。
import { DISPATCH_CANDIDATES_MAX } from '../config.ts'
import { panelPresence } from '../api/panel.ts'
import type { CordisContext, SessionsQueryService, WorkspaceRegistryService } from '../dsh-types.ts'
import { cwdBelongsToWorkspace, isRootSession, listNormalizedSessions, matchSessionWorkspaces, readSessionTitles, readSessionsByIds, type NormalizedSession } from '../session/session-records.ts'
import type { StoreSet } from '../store/index.ts'
import type { JevAnswers, JevScores } from '../jev/parse.ts'
import { computeJevScores } from '../jev/parse.ts'
import type { JevAnswers as AnswersType } from '../jev/parse.ts'
import type { BuiltJevRequest, DispatchSessionInput, DispatchWorkspaceInput, MappedAnswers } from '../jev/request.ts'
import { mapJevAnswers } from '../jev/request.ts'

export interface DispatchContext {
  workspaces: DispatchWorkspaceInput[]
  sessions: DispatchSessionInput[]
  /** 全部 allowed 工作区 id（白名单校验用）。 */
  allowedWorkspaceIds: string[]
  /** 工作区 id → 展示信息（path/name）。 */
  workspaceById: Map<string, DispatchWorkspaceInput>
  policyById: Map<string, 'inherit' | 'auto'>
}

const asArray = async (value: unknown): Promise<unknown[]> => {
  if (value === undefined || value === null) return []
  const resolved = await value
  return Array.isArray(resolved) ? resolved : []
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 工作区视角：registry.list()（同步/异步）∩ 已配置白名单（未配置 → allowed=false 不进入候选）。 */
async function collectWorkspaces(ctx: CordisContext, stores: StoreSet): Promise<{ workspaces: DispatchWorkspaceInput[]; policyById: Map<string, 'inherit' | 'auto'> }> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  const registered = await asArray(registry?.list?.())
  const stored = new Map(stores.workspaces.list().map((record) => [record.id, record]))
  const raw: Array<{ id: string; name: string; path: string }> = []
  for (const item of registered) {
    const record = item as { id?: unknown; name?: unknown; title?: unknown; path?: unknown }
    const id = asString(record.id)
    if (id === undefined) continue
    raw.push({ id, name: asString(record.name) ?? asString(record.title) ?? id, path: asString(record.path) ?? '' })
  }
  if (raw.length === 0) {
    for (const record of stored.values()) raw.push({ id: record.id, name: record.name || record.id, path: record.path })
  }
  const workspaces: DispatchWorkspaceInput[] = []
  const policyById = new Map<string, 'inherit' | 'auto'>()
  for (const item of raw) {
    const record = stored.get(item.id)
    if (record === undefined || record.allowed !== true) continue
    workspaces.push({
      id: item.id,
      name: item.name,
      path: item.path || record.path,
      summary: record.summary,
      recentSessionTitles: [],
    })
    policyById.set(item.id, record.capabilityPolicy.mode)
  }
  return { workspaces, policyById }
}

interface RegistryWorkspaceLike { id: string; path: string; sessionIds?: string[]; archivedSessionIds?: string[] }

/**
 * registry 的归档会话集合：SessionRecord 不携带归档状态，只有 workspaceRegistry 知道。
 * 真实服务把它挂在**服务级 getter** `archivedSessionIds`（全局集合），旧 fake/兼容形状也可能挂在
 * workspace 条目上，两者合并。
 */
async function archivedSessionIdsOf(ctx: CordisContext, registry: readonly RegistryWorkspaceLike[]): Promise<Set<string>> {
  const archived = new Set<string>()
  for (const workspace of registry) for (const id of workspace.archivedSessionIds ?? []) archived.add(id)
  try {
    const service = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
    for (const id of await asArray(service?.archivedSessionIds)) {
      if (typeof id === 'string' && id !== '') archived.add(id)
    }
  } catch {
    // 服务不可用：退回条目级集合（测试/旧宿主）
  }
  return archived
}

/** registry 工作区列表（含 sessionIds，用于无 cwd 时归属推断）。 */
async function registryWorkspacesOf(ctx: CordisContext): Promise<RegistryWorkspaceLike[]> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  const registered = await asArray(registry?.list?.())
  return registered.map((item) => {
    const record = item as { id?: unknown; path?: unknown; sessionIds?: unknown; archivedSessionIds?: unknown }
    return {
      id: asString(record.id) ?? '',
      path: asString(record.path) ?? '',
      sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((id): id is string => typeof id === 'string') : [],
      archivedSessionIds: Array.isArray(record.archivedSessionIds) ? record.archivedSessionIds.filter((id): id is string => typeof id === 'string') : [],
    }
  }).filter((workspace) => workspace.id !== '')
}

/** 归一后的会话 → 所属工作区 id（registry sessionIds 优先，其次 cwd 前缀）。 */
function workspaceIdOfSession(session: NormalizedSession, workspaces: RegistryWorkspaceLike[], allowedIds?: Set<string>): string | undefined {
  const matches = matchSessionWorkspaces(session, workspaces).filter((workspace) => allowedIds === undefined || allowedIds.has(workspace.id))
  if (matches.length === 0) return undefined
  // 多个候选时取 cwd 最长匹配（嵌套工作区）
  if (matches.length === 1) return (matches[0] as { id: string }).id
  const byPath = matches.filter((workspace) => cwdBelongsToWorkspace(session.cwd, workspace.path))
  const best = (byPath.length > 0 ? byPath : matches)
    .map((workspace) => workspaces.find((item) => item.id === workspace.id))
    .filter((workspace): workspace is RegistryWorkspaceLike => workspace !== undefined)
    .sort((a, b) => b.path.length - a.path.length)[0]
  return best?.id
}

/** 会话视角（性能路径）：allowed 工作区 registry.sessionIds → readTitleSnapshots(ids)（只读匹配 ids，绝不全量扫描）。 */
async function collectSessions(ctx: CordisContext, allowedWorkspaces: DispatchWorkspaceInput[], commanderSessionId: string): Promise<DispatchSessionInput[]> {
  const workspaceIds = new Set(allowedWorkspaces.map((workspace) => workspace.id))
  const registry = await registryWorkspacesOf(ctx)
  const archivedIds = await archivedSessionIdsOf(ctx, registry)
  const idsByWorkspace = new Map<string, string[]>()
  const allIds: string[] = []
  for (const workspace of registry) {
    if (!workspaceIds.has(workspace.id)) continue
    const ids = (workspace.sessionIds ?? []).filter((id) => id !== commanderSessionId && !archivedIds.has(id))
    idsByWorkspace.set(workspace.id, ids)
    for (const id of ids) allIds.push(id)
  }
  const sessions = new Map<string, NormalizedSession>()
  if (allIds.length > 0) {
    for (const [id, session] of await readSessionsByIds(ctx, allIds.slice(0, 800))) sessions.set(id, session)
    // 批量失败降级：仍用 registry ids 生成 bare 会话（title=''，不阻塞派发）
    if (sessions.size === 0) {
      for (const [workspaceId, ids] of idsByWorkspace) {
        for (const id of ids) sessions.set(id, { id, createdAt: 0, isChild: false, live: false, persisted: false, archived: false, title: '', titleUpdatedAt: 0 })
      }
    }
  } else {
    // 无 registry ids（旧宿主/隔离）：metadata 列表 + 仅 cwd 匹配后取标题（仍避免全量标题读取）。
    const listed = await listNormalizedSessions(ctx)
    const matched: NormalizedSession[] = []
    for (const session of listed.sessions) {
      if (session.id === commanderSessionId || session.isChild || session.archived || archivedIds.has(session.id)) continue
      const workspaceId = workspaceIdOfSession(session, registry, workspaceIds)
      if (workspaceId === undefined) continue
      matched.push(session)
      sessions.set(session.id, session)
    }
    const titles = await readSessionTitles(ctx, matched.slice(0, 800).map((session) => session.id))
    for (const session of matched) {
      const found = titles.get(session.id)
      if (found !== undefined) {
        session.title = found.title
        session.titleUpdatedAt = found.updatedAt
      }
    }
  }
  const result: DispatchSessionInput[] = []
  const seen = new Set<string>()
  for (const [id, session] of sessions) {
    if (id === commanderSessionId || seen.has(id) || session.isChild || session.archived || archivedIds.has(id)) continue
    const workspaceId = [...idsByWorkspace.entries()].find(([, ids]) => ids.includes(id))?.[0] ?? workspaceIdOfSession(session, registry, workspaceIds)
    if (workspaceId === undefined) continue
    seen.add(id)
    result.push({
      id,
      workspaceId,
      title: session.title,
      lastActiveAt: Math.max(session.createdAt, session.titleUpdatedAt),
      ...(session.contextUsage !== undefined ? { contextUsage: session.contextUsage } : {}),
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(session.agentPreset !== undefined ? { agentPreset: session.agentPreset } : {}),
    })
    if (result.length >= 800) break
  }
  result.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return result
}

export interface WorkspaceSessionView {
  id: string
  title: string
  createdAt: number
  lastActiveAt: number
  contextUsage?: number
  model?: string
  agentPreset?: string
  archived: boolean
}

export type WorkspaceSessionsResult =
  | { status: 'ok'; workspace: WorkspaceDirectoryEntry; sessions: WorkspaceSessionView[] }
  | { status: 'not_found' }

/**
 * 某工作区的会话列表（性能：优先 registry.sessionIds → readTitleSnapshots(ids)，O(会话数)，
 * 不再全量 listSessions；仅当 registry 无 ids 时回退 metadata listSessions 且标题只取匹配 ids）。
 */
export async function collectWorkspaceSessions(input: { ctx: CordisContext; stores: StoreSet; workspaceId: string; includeArchived?: boolean; maxSessions?: number }): Promise<WorkspaceSessionsResult> {
  const directory = await collectWorkspaceDirectory({ ctx: input.ctx, stores: input.stores })
  const workspace = directory.find((entry) => entry.id === input.workspaceId)
  if (workspace === undefined) return { status: 'not_found' }
  const commanderSessionId = input.stores.config.get().commander.sessionId
  const registry = await registryWorkspacesOf(input.ctx)
  const registryWorkspace = registry.find((item) => item.id === input.workspaceId)
  const byId = new Map<string, WorkspaceSessionView>()
  const toView = (session: NormalizedSession): WorkspaceSessionView => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    lastActiveAt: Math.max(session.createdAt, session.titleUpdatedAt),
    ...(session.contextUsage !== undefined ? { contextUsage: session.contextUsage } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.agentPreset !== undefined ? { agentPreset: session.agentPreset } : {}),
    archived: session.archived,
  })
  const archivedIds = await archivedSessionIdsOf(input.ctx, registry)
  const maxSessions = Math.min(Math.max(input.maxSessions ?? 200, 1), 1_000)
  // 先剔除归档再取 limit：否则大量归档会话会占满名额，真正的活跃会话读不到。
  // includeArchived=true 时保留归档 id（否则它们先被剔除、末尾的 includeArchived 过滤永远看不到）：
  // attach 校验依赖这一点给出「已归档，不能 attach」而不是「不存在」。
  const registryIds = (registryWorkspace?.sessionIds ?? (workspace.sessionIds ?? []))
    .filter((id) => id !== commanderSessionId && (input.includeArchived === true || !archivedIds.has(id)))
    .slice(0, maxSessions)
  if (registryIds.length > 0) {
    const fetched = await readSessionsByIds(input.ctx, registryIds)
    for (const id of registryIds) {
      const session = fetched.get(id)
      if (session === undefined) {
        // 批量读取失败/单条缺失：bare 降级（title=''、createdAt 0），不阻塞路由与绑定。
        byId.set(id, { id, title: '', createdAt: 0, lastActiveAt: 0, archived: false })
        continue
      }
      // D9：工具与面板共用根会话判据（排除子代理/teammate/指挥官）
      if (!isRootSession(session, commanderSessionId)) continue
      byId.set(id, toView(session))
    }
  } else {
    const listed = await listNormalizedSessions(input.ctx)
    const matched: NormalizedSession[] = []
    for (const session of listed.sessions) {
      if (!isRootSession(session, commanderSessionId)) continue
      if ((session.archived || archivedIds.has(session.id)) && input.includeArchived !== true) continue
      if (workspaceIdOfSession(session, registry) !== input.workspaceId) continue
      matched.push(session)
    }
    const titles = await readSessionTitles(input.ctx, matched.slice(0, maxSessions).map((session) => session.id))
    for (const session of matched) {
      const found = titles.get(session.id)
      if (found !== undefined) {
        session.title = found.title
        session.titleUpdatedAt = found.updatedAt
      }
      byId.set(session.id, toView(session))
    }
  }
  const sessions = [...byId.values()]
    // 归档状态以 registry 为准（SessionRecord/SessionHeader 不带 archived）：默认不返回归档会话。
    .map((session) => ({ ...session, archived: session.archived || archivedIds.has(session.id) }))
    .filter((session) => input.includeArchived === true || !session.archived)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return { status: 'ok', workspace, sessions }
}

/** 工作区段的会话标题证据：每个工作区最近活动的 10 条（已排除指挥官自身/子会话/归档）。 */
const RECENT_SESSION_TITLES_MAX = 10

function attachRecentSessionTitles(workspaces: DispatchWorkspaceInput[], sessions: DispatchSessionInput[]): void {
  const byWorkspace = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.title === '') continue
    const titles = byWorkspace.get(session.workspaceId) ?? []
    titles.push(session.title)
    byWorkspace.set(session.workspaceId, titles)
  }
  for (const workspace of workspaces) {
    workspace.recentSessionTitles = (byWorkspace.get(workspace.id) ?? []).slice(0, RECENT_SESSION_TITLES_MAX)
  }
}

/** 收集派发候选上下文（allowed workspaces + 非归档会话，排除指挥官会话）。 */
export async function collectDispatchContext(input: { ctx: CordisContext; stores: StoreSet; commanderSessionId: string }): Promise<DispatchContext> {
  const { workspaces, policyById } = await collectWorkspaces(input.ctx, input.stores)
  const sessions = await collectSessions(input.ctx, workspaces, input.commanderSessionId)
  attachRecentSessionTitles(workspaces, sessions)
  return {
    workspaces,
    sessions,
    allowedWorkspaceIds: workspaces.map((workspace) => workspace.id),
    workspaceById: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    policyById,
  }
}

export interface ConfirmationCandidate {
  workspaceId: string
  workspaceName: string
  workspacePath: string
  mode: 'new' | 'attach'
  sessionId?: string
  sessionTitle?: string
  pWorkspace: number
  pSession: number
  score: number
  reason?: string
}

export interface DispatchComputation {
  scores: JevScores
  recommendation: ConfirmationCandidate
  candidates: ConfirmationCandidate[]
  mapped: MappedAnswers
}

/** 推荐/候选：recommendation 排第一；其余候选按 Jev 概率排序，总数 ≤8。 */
export function buildDispatchCandidates(input: {
  context: DispatchContext
  answers: AnswersType | undefined
  mapped: MappedAnswers
  max?: number
}): DispatchComputation {
  const max = input.max ?? DISPATCH_CANDIDATES_MAX
  const scores = computeJevScores(input.answers ?? {})
  const mapped = input.mapped
  const workspaceId = mapped.workspaceId ?? input.context.workspaces[0]?.id ?? ''
  const workspace = input.context.workspaceById.get(workspaceId)
  const mode = mapped.mode ?? 'new'
  const sessionId = mode === 'attach' ? mapped.sessionId ?? undefined : undefined
  const session = sessionId !== undefined ? input.context.sessions.find((item) => item.id === sessionId) : undefined
  const recommendation: ConfirmationCandidate = {
    workspaceId,
    workspaceName: workspace?.name ?? workspaceId,
    workspacePath: workspace?.path ?? '',
    mode,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(session?.title !== undefined && session.title !== '' ? { sessionTitle: session.title } : {}),
    pWorkspace: scores.pWorkspace,
    pSession: scores.pSession,
    score: Number((scores.pWorkspace * Math.max(scores.pSession, mode === 'new' ? 1 : 0.5)).toFixed(4)),
    reason: 'recommendation',
  }
  const candidates: ConfirmationCandidate[] = [recommendation]
  // 其它工作区（new）作为备选；按 pWorkspace 概率降序（概率键为 synthetic id，无法回映射时按白名单顺序）。
  const wProbabilities = input.answers?.workspace?.probabilities ?? {}
  const probabilityByRealId = new Map<string, number>()
  if (input.answers?.workspace !== undefined) {
    for (const [synthetic, probability] of Object.entries(wProbabilities)) {
      // synthetic 形如 w_N，与上下文顺序对应
      const match = /^w_(\d+)$/.exec(synthetic)
      if (match !== null) {
        const workspaceAt = input.context.workspaces[Number(match[1])]
        if (workspaceAt !== undefined) probabilityByRealId.set(workspaceAt.id, probability)
      }
    }
  }
  const alternatives = input.context.workspaces
    .filter((item) => item.id !== recommendation.workspaceId)
    .map((item) => ({ item, probability: probabilityByRealId.get(item.id) ?? 0 }))
    .sort((a, b) => b.probability - a.probability)
  for (const alternative of alternatives) {
    if (candidates.length >= max) break
    candidates.push({
      workspaceId: alternative.item.id,
      workspaceName: alternative.item.name,
      workspacePath: alternative.item.path,
      mode: 'new',
      pWorkspace: alternative.probability,
      pSession: 0,
      score: Number(alternative.probability.toFixed(4)),
      reason: 'alternative_workspace',
    })
  }
  return { scores, recommendation, candidates, mapped }
}

/** 一致性校验：mode=attach 的会话必须属于所选工作区（否则 conflict）。 */
export function findTargetConflict(context: DispatchContext, mapped: MappedAnswers): { message: string } | null {
  if (mapped.mode !== 'attach' || mapped.sessionId === null) return null
  const session = context.sessions.find((item) => item.id === mapped.sessionId)
  if (session === undefined) return { message: `session '${mapped.sessionId}' is not an attachable non-archived session` }
  if (session.workspaceId !== mapped.workspaceId) return { message: `session '${mapped.sessionId}' belongs to '${session.workspaceId}', not '${mapped.workspaceId}'` }
  return null
}

export { panelPresence }


export interface WorkspaceDirectoryEntry {
  id: string
  name: string
  path: string
  allowed: boolean
  summary: string
  policy: 'inherit' | 'auto'
  /** registry 提供的会话 id 列表（性能：按 id 读取会话，避免全量 listSessions）。 */
  sessionIds?: string[]
}

/** 全部工作区目录（registry ∪ stores；含未 allowed）：commander_task_list 与 candidate 名称/路径解析共用。 */
export async function collectWorkspaceDirectory(input: { ctx: CordisContext; stores: StoreSet }): Promise<WorkspaceDirectoryEntry[]> {
  const registry = input.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  const registered = await asArray(registry?.list?.())
  const stored = new Map(input.stores.workspaces.list().map((record) => [record.id, record]))
  const byId = new Map<string, WorkspaceDirectoryEntry>()
  for (const item of registered) {
    const record = item as { id?: unknown; name?: unknown; title?: unknown; path?: unknown }
    const id = asString(record.id)
    if (id === undefined) continue
    const storedRecord = stored.get(id)
    const rawSessionIds = (record as { sessionIds?: unknown }).sessionIds
    byId.set(id, {
      id,
      name: asString(record.name) ?? asString(record.title) ?? storedRecord?.name ?? id,
      path: asString(record.path) ?? storedRecord?.path ?? '',
      allowed: storedRecord?.allowed ?? false,
      summary: storedRecord?.summary ?? '',
      policy: storedRecord?.capabilityPolicy.mode ?? 'inherit',
      ...(Array.isArray(rawSessionIds) ? { sessionIds: rawSessionIds.filter((value): value is string => typeof value === 'string') } : {}),
    })
  }
  for (const record of stored.values()) {
    if (byId.has(record.id)) continue
    byId.set(record.id, { id: record.id, name: record.name || record.id, path: record.path, allowed: record.allowed, summary: record.summary, policy: record.capabilityPolicy.mode })
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export type WorkspaceReferenceResolution =
  | { status: 'resolved'; workspace: WorkspaceDirectoryEntry }
  | { status: 'ambiguous'; candidates: WorkspaceDirectoryEntry[] }
  | { status: 'not_found'; allowedHint: string }

const normalizeRef = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * candidate.workspaceId 允许传 id / name / path（大小写、首尾空格归一；path 比较同时接受 basename）。
 * 解析不唯一 → ambiguous（调用方返回 needs_confirmation，不直接 no_workspace）。
 */
export function resolveWorkspaceReference(directory: WorkspaceDirectoryEntry[], reference: string): WorkspaceReferenceResolution {
  const raw = String(reference ?? '').trim()
  if (raw === '') return { status: 'not_found', allowedHint: '' }
  const normalized = normalizeRef(raw)
  const matches = directory.filter((entry) => {
    if (normalizeRef(entry.id) === normalized) return true
    if (normalizeRef(entry.name) === normalized) return true
    if (entry.path !== '') {
      if (normalizeRef(entry.path) === normalized) return true
      const base = entry.path.replace(/\/+$/, '').split('/').filter(Boolean).pop()
      if (base !== undefined && normalizeRef(base) === normalized) return true
    }
    return false
  })
  if (matches.length === 1) return { status: 'resolved', workspace: matches[0] as WorkspaceDirectoryEntry }
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches }
  const allowed = directory.filter((entry) => entry.allowed).map((entry) => entry.id)
  return { status: 'not_found', allowedHint: allowed.length > 0 ? allowed.join(', ') : '（当前没有 allowed 工作区）' }
}
