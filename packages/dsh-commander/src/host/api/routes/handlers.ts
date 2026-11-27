// /commander/* 各路由 handler（M0：health/state/config/workspaces/binding/message）。
// 只做校验 + 调 store/session 服务 + 组装响应；业务写逻辑在 store/session 模块。
import type { ApiDeps } from '../server.ts'
import { ApiError } from '../errors.ts'
import { validateBindingBody, validateConfigPatch, validateMessageBody, validateRotationBody, validateWorkspacesBody } from '../validation.ts'
import { buildSnapshot, buildWorkspaceViews, type CommanderSnapshot } from '../state.ts'
import { readSessionEvents } from '../../session/session-records.ts'
import type { SessionEventLike } from '../../dsh-types.ts'
import { BindingError } from '../../session/binding.ts'
import { DeliverError } from '../../session/deliver.ts'
import { defaultWorkspaceRecord, type ConfigRecord, type WorkspaceRecord } from '../../schema.ts'
import { resolveJevKey, callJev } from '../../jev/client.ts'
import { capabilitySummary } from '../../dispatch/capability.ts'
import { resolveJevThresholds } from '../../config.ts'
import { resolveRotation, patchRotation } from '../../rotation/config.ts'
import { RotationError } from '../../rotation/service.ts'
import { migrateCommanderSchedules, scheduleMigrationFailure, type ScheduleMigrationResult } from '../../schedule/migration.ts'
import { collectWorkspaceSessions } from '../../dispatch/candidates.ts'
import { isSessionLive, readSessionsByIds } from '../../session/session-records.ts'
import { dependenciesMet, hasPendingDependents, isReady, waitingFor } from '../../tasks/dependencies.ts'

export interface JsonResult { status: number; body: unknown }

const nowOf = (deps: ApiDeps): number => (deps.now ?? (() => Date.now()))()

export async function snapshotOf(deps: ApiDeps): Promise<CommanderSnapshot> {
  const snapshot = await buildSnapshot({
    ctx: deps.ctx,
    stores: deps.stores,
    binding: deps.binding.view(),
    messages: deps.messages.snapshot(),
    commanderBusy: deps.getStatus().busy,
    commanderActivity: deps.getStatus().activity,
    rev: deps.sse.rev,
    ...(deps.getPendingDispatch !== undefined ? { pendingDispatch: deps.getPendingDispatch() } : {}),
    ...(deps.getMetrics !== undefined ? { metrics: deps.getMetrics() } : {}),
    ...(deps.getRotation !== undefined ? { rotation: deps.getRotation() } : {}),
    ...(deps.getFormerCommanders !== undefined ? { formerCommanders: deps.getFormerCommanders() } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  // M4 加法字段：原生壳状态（Client 用来隐藏页内球；旧字段不变）。
  return deps.nativeShellStatus === undefined ? snapshot : { ...snapshot, nativeShell: deps.nativeShellStatus() }
}

/** 任务详情里的材料投影：本地图片补签名 imageUrl；远程/文档不加。 */
function materialViewOf(deps: ApiDeps, taskId: string, material: import('../../schema.ts').ReportMaterial): Record<string, unknown> {
  const imageUrl = deps.materialAssets?.url(taskId, material)
  return { ...material, ...(imageUrl !== undefined ? { imageUrl } : {}) }
}

/** 当前全局未决确认卡的任务 id（快照 pendingDispatch 只允许一张卡）。 */
function pendingDispatchTaskId(deps: ApiDeps): string | undefined {
  const pending = deps.getPendingDispatch?.() as { taskId?: unknown } | null | undefined
  return pending !== null && pending !== undefined && typeof pending.taskId === 'string' ? pending.taskId : undefined
}

/** 任务依赖派生视图（看板/详情共用；Host 只读派生，不自动推进）。 */
function dependencyViewOf(deps: ApiDeps, task: import('../../schema.ts').TaskRecord): {
  dependsOn: string[]
  waitingFor: string[]
  ready: boolean
  hasPendingDependents: boolean
  pendingDispatch: boolean
} {
  const lookup = (id: string): import('../../schema.ts').TaskRecord | undefined => deps.stores.tasks.get(id)
  return {
    dependsOn: task.dependsOn ?? [],
    waitingFor: waitingFor(task, lookup),
    ready: isReady(task, lookup),
    hasPendingDependents: hasPendingDependents(deps.stores.tasks.list(), task.id),
    pendingDispatch: pendingDispatchTaskId(deps) === task.id,
  }
}

/** GET /commander/tasks/:id（M1 只读任务详情，m1-contract-patch §3.3）。 */
export async function handleTaskGet(deps: ApiDeps, taskId: string): Promise<JsonResult> {
  const task = deps.stores.tasks.get(taskId)
  if (task === undefined) throw new ApiError('not_found', `task '${taskId}' not found`)
  const dependencyView = dependencyViewOf(deps, task)
  const dispatch = task.dispatchId !== undefined ? deps.stores.dispatches.get(task.dispatchId) : undefined
  const dispatches = deps.stores.dispatches.list()
    .filter((record) => record.taskId === task.id)
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
  const links = deps.stores.sessions.list().filter((link) => link.taskId === task.id)
  // 抽屉「关联会话」要显示 工作区 · 会话标题（只给 id 人读不出来）：批量读会话标题快照，工作区名取配置副本。
  const titles = await readSessionsByIds(deps.ctx, links.map((link) => link.sessionId))
  const sessions = await Promise.all(links.map(async (link) => ({
    sessionId: link.sessionId,
    workspaceId: link.workspaceId,
    workspaceName: deps.stores.workspaces.get(link.workspaceId)?.name ?? '',
    sessionTitle: titles.get(link.sessionId)?.title ?? '',
    role: link.role,
    mode: link.mode,
    round: link.round ?? 1,
    // 重启/停止后残留的 running：会话已不在内存 → 按 idle 显示（否则"会话已停止仍显示 running"，加载状态只能等重启）
    status: link.status === 'running' && !(await isSessionLive(deps.ctx, link.sessionId)) ? 'idle' : link.status,
  })))
  return {
    status: 200,
    body: {
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        workspaceId: task.workspaceId,
        priority: task.priority,
        commandId: task.commandId,
        round: task.round ?? 1,
        workspaceIds: task.workspaceIds ?? (task.workspaceId !== '' ? [task.workspaceId] : []),
        ...(task.primarySessionId !== undefined ? { primarySessionId: task.primarySessionId } : {}),
        assignments: task.assignments,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        lastActivityAt: task.lastActivityAt,
        version: task.version,
        ...dependencyView,
        ...(task.acceptNote !== undefined ? { acceptNote: task.acceptNote } : {}),
        ...(task.acceptedBy !== undefined ? { acceptedBy: task.acceptedBy } : {}),
        ...(task.archivedFrom !== undefined ? { archivedFrom: task.archivedFrom } : {}),
      },
      acceptance: task.acceptance,
      ...(task.acceptanceHistory !== undefined
        ? {
            acceptanceHistory: task.acceptanceHistory.map((round) => ({
              ...round,
              ...(round.materials !== undefined && round.materials.length > 0
                ? { materials: round.materials.map((material) => materialViewOf(deps, task.id, material)) }
                : {}),
            })),
          }
        : {}),
      ...(task.pendingInstruction !== undefined ? { pendingInstruction: task.pendingInstruction } : {}),
      ...(task.reportSummary !== undefined ? { reportSummary: task.reportSummary } : {}),
      ...(task.reportMaterials !== undefined && task.reportMaterials.length > 0
        ? { reportMaterials: task.reportMaterials.map((material) => materialViewOf(deps, task.id, material)) }
        : {}),
      ...(task.capabilities !== undefined ? { capabilities: task.capabilities } : { capabilities: null }),
      dispatch: dispatch ?? null,
      dispatches,
      timeline: task.timeline,
      sessions,
      boardEdits: deps.boardService?.detailBoardEdits(task.id) ?? [],
      ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
      rev: deps.sse.rev,
    },
  }
}

function boardServiceOf(deps: ApiDeps) {
  if (deps.boardService === undefined) throw new ApiError('internal', 'board service is unavailable')
  return deps.boardService
}

function taskSummary(deps: ApiDeps, task: import('../../schema.ts').TaskRecord) {
  const dependencyView = dependencyViewOf(deps, task)
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    workspaceId: task.workspaceId,
    priority: task.priority,
    commandId: task.commandId,
    round: task.round ?? 1,
    pendingContinue: task.pendingInstruction !== undefined,
    ...(task.pendingInstruction !== undefined ? { pendingInstruction: task.pendingInstruction } : {}),
    ...(task.primarySessionId !== undefined ? { primarySessionId: task.primarySessionId } : {}),
    assignments: task.assignments,
    acceptance: task.acceptance,
    timeline: task.timeline,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastActivityAt: task.lastActivityAt,
    version: task.version,
    ...dependencyView,
    ...(task.acceptNote !== undefined ? { acceptNote: task.acceptNote } : {}),
    ...(task.acceptedBy !== undefined ? { acceptedBy: task.acceptedBy } : {}),
    ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
  }
}

/** PATCH /commander/board/tasks/:id（M2 人工改板：只允许 priority|title；异步合并注入 [board-edit]）。 */
export async function handleBoardPatch(deps: ApiDeps, taskId: string, body: unknown): Promise<JsonResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError('invalid_request', 'body must be an object')
  const input = body as Record<string, unknown>
  const result = await boardServiceOf(deps).patchTask(taskId, { field: input.field, value: input.value, editId: input.editId, requestId: input.requestId })
  if (!result.ok) {
    if ('invalid' in result && result.invalid) throw new ApiError('invalid_request', result.message, result.field !== undefined ? { field: result.field } : {})
    throw new ApiError('conflict', result.message)
  }
  return {
    status: 200,
    body: {
      ok: true,
      task: taskSummary(deps, result.task),
      boardEdit: result.boardEdit,
      duplicate: result.duplicate,
      rev: deps.sse.rev,
    },
  }
}

/** POST /commander/tasks/:id/archive|restore（M2 回收站）。 */
export async function handleTaskAction(deps: ApiDeps, taskId: string, action: 'archive' | 'restore'): Promise<JsonResult> {
  const service = boardServiceOf(deps)
  const task = deps.stores.tasks.get(taskId)
  if (task === undefined) throw new ApiError('not_found', `task '${taskId}' not found`)
  const result = action === 'archive' ? await service.archiveTask(taskId) : await service.restoreTask(taskId)
  if (result.ok && action === 'archive') deps.onTaskSettled?.(taskId)
  if (!result.ok) {
    if ('invalid' in result && result.invalid) throw new ApiError('invalid_request', result.message)
    throw new ApiError('conflict', result.message)
  }
  return { status: 200, body: { ok: true, task: taskSummary(deps, result.task), duplicate: result.duplicate, rev: deps.sse.rev } }
}

/**
 * GET /commander/archive?limit=&cursor=&q=&status=&workspaceId=&from=&to=
 * （回收站列表，只读；m2m3-contract-patch §2.5.1）。
 */
export async function handleArchiveList(
  deps: ApiDeps,
  limitRaw?: string,
  cursorRaw?: string,
  qRaw?: string,
  statusRaw?: string,
  workspaceIdRaw?: string,
  fromRaw?: string,
  toRaw?: string,
): Promise<JsonResult> {
  const limit = limitRaw === undefined || limitRaw === '' ? 50 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_request', 'limit must be an integer in 1..100', { field: 'limit' })
  const cursor = cursorRaw === undefined || cursorRaw === '' ? NaN : Number(cursorRaw)
  if (cursorRaw !== undefined && cursorRaw !== '' && !Number.isFinite(cursor)) throw new ApiError('invalid_request', 'cursor must be a number', { field: 'cursor' })
  const q = (qRaw ?? '').trim()
  if (q.length > 100) throw new ApiError('invalid_request', 'q must be at most 100 characters', { field: 'q' })
  const status = statusRaw === undefined || statusRaw === '' ? undefined : statusRaw
  if (status !== undefined && status !== 'archived' && status !== 'cancelled') {
    throw new ApiError('invalid_request', 'status must be archived or cancelled', { field: 'status' })
  }
  const workspaceId = (workspaceIdRaw ?? '').trim()
  const parseMs = (raw: string | undefined, field: 'from' | 'to'): number | undefined => {
    if (raw === undefined || raw === '') return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new ApiError('invalid_request', `${field} must be a non-negative epoch ms`, { field })
    return value
  }
  const from = parseMs(fromRaw, 'from')
  const to = parseMs(toRaw, 'to')
  if (from !== undefined && to !== undefined && from >= to) {
    throw new ApiError('invalid_request', 'from must be smaller than to', { field: 'from' })
  }
  const result = boardServiceOf(deps).listArchive({
    limit,
    ...(Number.isFinite(cursor) ? { cursor } : {}),
    ...(q !== '' ? { q } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(workspaceId !== '' ? { workspaceId } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  })
  return {
    status: 200,
    body: {
      ok: true,
      tasks: result.tasks.map((task: import('../../schema.ts').TaskRecord) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        workspaceId: task.workspaceId,
        priority: task.priority,
        round: task.round ?? 1,
        sessionCount: task.assignments.length,
        updatedAt: task.updatedAt,
        lastActivityAt: task.lastActivityAt,
        ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
      })),
      nextCursor: result.nextCursor,
      total: result.total,
      summary: result.summary,
      months: result.months,
      rev: deps.sse.rev,
    },
  }
}

/** GET /commander/sessions?workspaceId=…&limit=…（M1R：只读会话列表，供确认卡自定义 attach；不返回正文）。 */
export async function handleSessionsGet(deps: ApiDeps, workspaceId: string, limitRaw?: string): Promise<JsonResult> {
  if (workspaceId.trim() === '') throw new ApiError('invalid_request', 'workspaceId query parameter is required', { field: 'workspaceId' })
  const limit = limitRaw === undefined || limitRaw === '' ? 50 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError('invalid_request', 'limit must be an integer in 1..100', { field: 'limit' })
  }
  // 性能：只按 limit 读取目标工作区会话（避免为整个工作区折叠标题）；truncated 用 registry id 总数近似。
  const result = await collectWorkspaceSessions({ ctx: deps.ctx, stores: deps.stores, workspaceId: workspaceId.trim(), maxSessions: limit })
  if (result.status === 'not_found') throw new ApiError('not_found', `workspace '${workspaceId}' not found`)
  const all = result.sessions.filter((session) => !session.archived)
  const truncated = (result.workspace.sessionIds?.length ?? all.length) > limit || all.length > limit
  const sessions = all.slice(0, limit).map((session) => ({
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    ...(session.contextUsage !== undefined ? { contextUsage: session.contextUsage } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.agentPreset !== undefined ? { agentPreset: session.agentPreset } : {}),
    archived: false,
  }))
  return { status: 200, body: { ok: true, workspaceId: result.workspace.id, workspaceName: result.workspace.name, sessions, truncated, rev: deps.sse.rev } }
}

/** POST /commander/jev/test（M1：Host 侧最小探针；永不回传 Key）。 */
export async function handleJevTest(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const config = deps.stores.config.get().jev
  const endpoint = typeof record.endpoint === 'string' && record.endpoint !== '' ? record.endpoint : config.endpoint
  const model = typeof record.model === 'string' && record.model !== '' ? record.model : config.model
  const envVar = typeof record.apiKeyEnv === 'string' && record.apiKeyEnv !== '' ? record.apiKeyEnv : config.envVar
  const timeoutRaw = record.timeoutMs
  const timeoutMs = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) ? Math.min(30_000, Math.max(500, Math.floor(timeoutRaw))) : config.timeoutMs
  const key = resolveJevKey(envVar)
  const requestId = `probe_${Date.now().toString(36)}`
  if (key.key === null) return { status: 200, body: { ok: false, code: 'jev_unavailable', message: `Jev API key env '${key.envVar}' is not set`, latencyMs: 0, requestId, apiKeyEnv: key.envVar, hasApiKey: false } }
  const probeBody = {
    model,
    state: { task: { title: 'probe', goal: 'probe' }, constraints: { allowedWorkspaces: ['probe_a', 'probe_b'] } },
    questions: {
      workspace: {
        type: 'choice',
        instructions: 'probe: which workspace?',
        criteria: { probe_a: { what: 'probe_a' }, probe_b: { what: 'probe_b' } },
      },
    },
  }
  const startedAt = performance.now()
  const result = await callJev({ endpoint, model, envVar, timeoutMs }, probeBody)
  const latencyMs = Math.round(performance.now() - startedAt)
  if (!result.ok) {
    return {
      status: 200,
      body: {
        ok: false,
        code: result.error?.code === 'no_key' ? 'jev_unavailable' : result.error?.code === 'auth' ? 'auth' : result.error?.code === 'timeout' ? 'timeout' : 'jev_unavailable',
        message: result.error?.message ?? 'Jev probe failed',
        latencyMs,
        requestId,
        apiKeyEnv: key.envVar,
        hasApiKey: true,
      },
    }
  }
  return { status: 200, body: { ok: true, latencyMs, model: result.model ?? model, requestId, apiKeyEnv: key.envVar, hasApiKey: true } }
}

export async function handleHealth(deps: ApiDeps): Promise<JsonResult> {
  const status = deps.binding.view().status
  return {
    status: 200,
    body: {
      ok: true,
      version: deps.version,
      panel: deps.panelPresence(),
      binding: status === 'bound' ? 'bound' : status === 'broken' ? 'broken' : 'unbound',
      // M4 加法字段：原生壳进程状态（旧客户端忽略即可）。
      ...(deps.nativeShellStatus === undefined ? {} : { nativeShell: deps.nativeShellStatus() }),
      ...(deps.nativeShellPid === undefined ? {} : { nativeShellPid: deps.nativeShellPid() }),
    },
  }
}

export async function handleStateJson(deps: ApiDeps): Promise<JsonResult> {
  return { status: 200, body: { ok: true, ...(await snapshotOf(deps)) } }
}

/** 可展示 config 视图：不含 Jev Key 明文；绑定字段只读回显。 */
export function configView(config: ConfigRecord): Record<string, unknown> {
  const rotation = resolveRotation(config)
  return {
    commander: {
      workspaceId: config.commander.workspaceId,
      workspacePath: config.commander.workspacePath,
      sessionId: config.commander.sessionId,
      model: config.commander.model,
      ...(config.commander.agentPreset !== undefined ? { agentPreset: config.commander.agentPreset } : {}),
      allowCommanderAccept: config.commander.allowCommanderAccept !== false,
      rotation: {
        enabled: rotation.enabled,
        periodDays: rotation.periodDays,
        includeUserTail: rotation.includeUserTail,
        toolAudit: rotation.toolAudit,
        generation: rotation.generation,
        generationStartedAt: rotation.generationStartedAt,
      },
    },
    jev: {
      provider: config.jev.provider,
      endpoint: config.jev.endpoint,
      model: config.jev.model,
      apiKeyEnv: config.jev.envVar,
      workspaceThreshold: resolveJevThresholds(config.jev).workspace,
      sessionThreshold: resolveJevThresholds(config.jev).session,
      timeoutMs: config.jev.timeoutMs,
      autoDispatch: config.jev.autoDispatch === true,
    },
    board: config.board,
    ui: config.ui,
    updatedAt: config.updatedAt,
  }
}

/**
 * GET /commander/config —— 只读展示视图（契约补丁无此路由；Client 设置页打开时会先探测它，
 * 缺失则回退默认值，见 packages/dsh-commander/src/client/store.ts loadConfig）。加法式只读路由，不写盘、不含 Jev Key。
 */
export async function handleConfigGet(deps: ApiDeps): Promise<JsonResult> {
  return { status: 200, body: { ok: true, config: configView(deps.stores.config.get()), rev: deps.sse.rev } }
}

export async function handleConfigPut(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  const patch = validateConfigPatch(body)
  const config = await deps.stores.config.update((current) => {
    const next: ConfigRecord = { ...current, updatedAt: nowOf(deps) }
    if (patch.commander !== undefined) {
      const commanderNext = {
        ...current.commander,
        ...(patch.commander.model !== undefined ? { model: { ...current.commander.model, ...patch.commander.model } } : {}),
        ...(patch.commander.agentPreset !== undefined ? { agentPreset: patch.commander.agentPreset } : {}),
        ...(patch.commander.allowCommanderAccept !== undefined ? { allowCommanderAccept: patch.commander.allowCommanderAccept } : {}),
      }
      if (patch.commander.rotation !== undefined) {
        const currentRotation = current.commander.rotation
        const enabling = patch.commander.rotation.enabled === true && currentRotation?.enabled !== true
        const needsStart = enabling && (currentRotation?.generationStartedAt === undefined || currentRotation.generationStartedAt <= 0)
        commanderNext.rotation = patchRotation(currentRotation, {
          ...patch.commander.rotation,
          ...(needsStart ? { generationStartedAt: nowOf(deps) } : {}),
        }, nowOf(deps))
      }
      next.commander = commanderNext
    }
    if (patch.jev !== undefined) {
      next.jev = {
        ...current.jev,
        ...(patch.jev.endpoint !== undefined ? { endpoint: patch.jev.endpoint } : {}),
        ...(patch.jev.model !== undefined ? { model: patch.jev.model } : {}),
        ...(patch.jev.apiKeyEnv !== undefined ? { envVar: patch.jev.apiKeyEnv } : {}),
        ...(patch.jev.workspaceThreshold !== undefined ? { workspaceThreshold: patch.jev.workspaceThreshold } : {}),
        ...(patch.jev.sessionThreshold !== undefined ? { sessionThreshold: patch.jev.sessionThreshold } : {}),
        ...(patch.jev.timeoutMs !== undefined ? { timeoutMs: patch.jev.timeoutMs } : {}),
        ...(patch.jev.autoDispatch !== undefined ? { autoDispatch: patch.jev.autoDispatch } : {}),
      }
    }
    if (patch.ui !== undefined) {
      next.ui = { ...current.ui, ...patch.ui }
    }
    return next
  }, nowOf(deps))
  deps.sse.broadcast('snapshot', await snapshotOf(deps))
  return { status: 200, body: { ok: true, config: configView(config), rev: deps.sse.rev } }
}

export async function handleWorkspacesPut(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  const parsed = validateWorkspacesBody(body)
  const registry = deps.ctx.get('workspaceRegistry') as { list?: () => Promise<Array<{ id: string; name?: string; title?: string; path: string }>> } | undefined
  let registered: Array<{ id: string; name?: string; title?: string; path: string }> = []
  if (registry?.list !== undefined) registered = await registry.list()
  const byId = new Map(registered.map((item) => [item.id, item]))
  const records: WorkspaceRecord[] = parsed.workspaces.map((item) => {
    const found = byId.get(item.id)
    if (found === undefined && registry !== undefined) throw new ApiError('unknown_workspace', `workspace '${item.id}' not found`, { field: 'workspaces' })
    const record = defaultWorkspaceRecord({ id: item.id, name: found?.name ?? found?.title ?? item.id, path: found?.path ?? '' })
    return {
      ...record,
      allowed: item.allowed,
      summary: item.summary,
      summarySource: 'manual',
      ...(item.summary !== '' ? { summaryUpdatedAt: nowOf(deps) } : {}),
      capabilityPolicy: { ...record.capabilityPolicy, mode: item.policy },
    }
  })
  await deps.stores.workspaces.replaceAll(records)
  deps.sse.broadcast('snapshot', await snapshotOf(deps))
  return { status: 200, body: { ok: true, workspaces: await buildWorkspaceViews(deps.ctx, deps.stores), rev: deps.sse.rev } }
}

export async function handleBindingPost(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  const parsed = validateBindingBody(body)
  // 绑定前快照旧 commander：迁移只认「本次被替换掉的那个会话」，不碰其它 commander/工作会话。
  const fromSessionId = deps.binding.getConfig().commander.sessionId
  try {
    const view = parsed.mode === 'new'
      ? await deps.binding.bindNew({ ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}), ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}), ...(parsed.agentPreset !== undefined ? { agentPreset: parsed.agentPreset } : {}) })
      : await deps.binding.bindSelect({ ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}), sessionId: parsed.sessionId })
    let scheduleMigration: ScheduleMigrationResult | undefined
    if (fromSessionId !== '' && fromSessionId !== view.binding.sessionId) {
      // 绑定已成功：迁移是 post-commit 补偿，失败只告警，不回滚绑定。
      try {
        const migrate = deps.migrateSchedules ?? migrateCommanderSchedules
        scheduleMigration = await migrate({
          ctx: deps.ctx,
          fromSessionId,
          toSessionId: view.binding.sessionId,
          isCommanderSession: (candidate) => deps.stores.sessions.list().some((link) => link.sessionId === candidate && link.role === 'commander'),
          isCurrentCommander: (candidate) => deps.binding.getConfig().commander.sessionId === candidate,
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        })
      } catch (error: unknown) {
        scheduleMigration = scheduleMigrationFailure(fromSessionId, view.binding.sessionId, 'migration_threw')
        deps.logger?.warn?.(`[commander] binding schedule migration threw: ${String((error as Error)?.message ?? error)}`)
      }
    }
    deps.sse.broadcast('binding.updated', {
      binding: view.binding,
      commanderStatus: view.status,
      ...(scheduleMigration !== undefined ? { scheduleMigration } : {}),
      rev: deps.sse.rev,
    })
    return {
      status: 200,
      body: {
        ok: true,
        binding: view.binding,
        commanderStatus: view.status,
        ...(scheduleMigration !== undefined ? { scheduleMigration } : {}),
        rev: deps.sse.rev,
      },
    }
  } catch (error) {
    if (error instanceof BindingError) {
      throw new ApiError(error.code as never, error.message)
    }
    throw error
  }
}

export async function handleMessagePost(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  const parsed = validateMessageBody(body)
  // R1 兜底：到点且边界安全时先换任，消息落到新会话；失败静默，不影响投递。
  if (deps.rotation !== undefined) {
    try {
      await deps.rotation.beforeDeliver()
    } catch {
      /* 轮换失败不阻塞用户消息 */
    }
  }
  // 先分配 order 写入 user echo（architect M5：避免 assistant 先回造成 order 倒置）；prompt 失败时回滚。
  const userMessage = deps.messages.reserve({ messageId: parsed.requestId, role: 'user', text: parsed.text, at: nowOf(deps) })
  try {
    const result = await deps.deliverer.deliverUserMessage(parsed.text, parsed.requestId)
    if (userMessage !== null) deps.sse.broadcast('commander.message', userMessage)
    return {
      status: 200,
      body: {
        ok: true,
        requestId: parsed.requestId,
        messageId: parsed.requestId,
        sessionId: result.sessionId,
        accepted: result.accepted,
        queued: result.queued,
        busy: deps.getStatus().busy,
        rev: deps.sse.rev,
      },
    }
  } catch (error) {
    deps.messages.remove(parsed.requestId) // 失败不产生幽灵消息（契约 §1.3-6）
    if (error instanceof DeliverError) throw new ApiError(error.code, error.message)
    throw error
  }
}


/** POST /commander/tasks/:id/accept（人专用：仅 review→done；body.note = 可选交接说明）。 */
export async function handleTaskAccept(deps: ApiDeps, taskId: string, body?: unknown): Promise<JsonResult> {
  if (deps.taskActions === undefined) throw new ApiError('internal', 'task actions are unavailable')
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (input.note !== undefined && typeof input.note !== 'string') throw new ApiError('invalid_request', 'note must be a string')
  const note = typeof input.note === 'string' ? input.note : undefined
  const result = await deps.taskActions.accept(taskId, note !== undefined ? { note } : {})
  if (!result.ok) throw new ApiError(result.kind, result.message)
  return { status: 200, body: { ok: true, task: taskSummary(deps, result.task), duplicate: result.duplicate, rev: deps.sse.rev } }
}

/** POST /commander/tasks/:id/cancel（人专用：非终态→cancelled；先停会话，失败不落状态）。 */
export async function handleTaskCancel(deps: ApiDeps, taskId: string): Promise<JsonResult> {
  const result = await boardServiceOf(deps).cancelTask(taskId)
  if (!result.ok) throw new ApiError('conflict', result.message)
  deps.onTaskSettled?.(taskId)
  return { status: 200, body: { ok: true, task: taskSummary(deps, result.task), duplicate: result.duplicate, rev: deps.sse.rev } }
}

/** POST /commander/tasks/:id/continue（M5 人专用：只写批注并通知指挥官，不改状态）；/rework 为兼容别名。 */
export async function handleTaskContinue(deps: ApiDeps, taskId: string, body: unknown): Promise<JsonResult> {
  if (deps.taskActions === undefined) throw new ApiError('internal', 'task actions are unavailable')
  const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const result = await deps.taskActions.requestContinue(taskId, input.comment, input.requestId)
  if (!result.ok) throw new ApiError(result.kind, result.message)
  return {
    status: 200,
    body: { ok: true, task: taskSummary(deps, result.task), notified: result.notified, duplicate: result.duplicate, rev: deps.sse.rev },
  }
}


/**
 * GET /commander/session-transcript?sessionId=&limit= —— 原生壳的只读会话窗口。
 * 从会话事件里取真实 user/assistant 文本（跳过注入/系统来源），最多 200 条。
 */
export async function handleSessionTranscript(deps: ApiDeps, sessionId: string, limitRaw: string | null): Promise<{ status: number; body: unknown }> {
  if (sessionId.trim() === '') throw new ApiError('invalid_request', 'sessionId is required', { field: 'sessionId' })
  const parsed = Number(limitRaw ?? '80')
  const limit = Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.floor(parsed))) : 80
  const events: SessionEventLike[] = await readSessionEvents(deps.ctx, sessionId)
  const messages: Array<{ role: 'user' | 'assistant'; text: string; at?: number }> = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const message = (data.message ?? data) as Record<string, unknown>
    const content = message.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
      .trim()
    if (text.length === 0) continue
    if (event.type === 'user/message') {
      const source = (data as { source?: { kind?: string } }).source
      if (source?.kind !== undefined && source.kind !== 'user') continue
      messages.push({ role: 'user', text, ...(typeof event.time === 'number' ? { at: event.time } : {}) })
    } else {
      messages.push({ role: 'assistant', text, ...(typeof event.time === 'number' ? { at: event.time } : {}) })
    }
  }
  return { status: 200, body: { ok: true, sessionId, messages: messages.slice(-limit) } }
}

/**
 * POST /commander/rotation（R1）——手动/强制换任。
 * `force=true` 跳过周期与活动判定；`enabled=false` 时恒 409 rotation_disabled。
 */
export async function handleRotation(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  if (deps.rotation === undefined) throw new ApiError('rotation_disabled', 'rotation service is unavailable')
  const parsed = validateRotationBody(body)
  try {
    const result = await deps.rotation.rotate({ force: parsed.force, reason: 'manual' })
    return {
      status: 200,
      body: {
        ok: true,
        rotated: result.rotated,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        generation: result.generation,
        rotation: result.rotation,
        ...(result.sessionId !== '' ? { sessionId: result.sessionId } : {}),
        ...(result.previousSessionId !== undefined ? { previousSessionId: result.previousSessionId } : {}),
        ...(result.startedAt !== undefined ? { startedAt: result.startedAt } : {}),
        ...(result.brief !== undefined ? { brief: result.brief } : {}),
        ...(result.scheduleMigration !== undefined ? { scheduleMigration: result.scheduleMigration } : {}),
        rev: deps.sse.rev,
      },
    }
  } catch (error) {
    if (error instanceof RotationError) {
      throw new ApiError(error.code, error.message, error.code === 'rotation_failed' ? { retryable: true } : {})
    }
    throw error
  }
}
