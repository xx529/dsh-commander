// GET /commander/state 快照构造（implementation-plan §8.3 + m0-contract-patch §1.6）。
import { SNAPSHOT_TASKS_MAX } from '../config.ts'
import { taskIsStale } from '../board/service.ts'
import type { CommanderMessage } from '../session/messages.ts'
import type { BindingView, CommanderStatus } from '../session/binding.ts'
import type { StoreSet } from '../store/index.ts'
import type { CordisContext, WorkspaceRegistryService } from '../dsh-types.ts'
import type { TaskRecord, WorkspaceRecord } from '../schema.ts'
import { WORK_SESSIONS_MAX } from '../config.ts'
import { panelPresence } from './panel.ts'
import { capabilitySummary } from '../dispatch/capability.ts'
import type { FormerCommander, RotationView } from '../rotation/service.ts'
import { isReady, waitingFor } from '../tasks/dependencies.ts'

export interface WorkspaceView {
  id: string
  name: string
  path: string
  allowed: boolean
  summary: string
  policy: 'inherit' | 'auto'
  lastSelection: null
}

export interface TaskView {
  id: string
  title: string
  status: string
  workspaceId: string
  workspaceIds: string[]
  priority: string
  round: number
  pendingContinue: boolean
  primarySessionId?: string
  sessionCount: number
  acceptanceCount: number
  evidenceInsufficientCount: number
  stale: boolean
  archivedAt?: number
  lastActivityAt: number
  capability?: { status: string; enabledCount: number; disabledCount: number; durationMs?: number }
  updatedAt: number
  /** task-state-machine-final §6：依赖与派生 ready（Host 只读派生）。 */
  dependsOn: string[]
  waitingFor: string[]
  ready: boolean
  /** 全局单确认卡：该任务是否有未决确认。 */
  pendingDispatch: boolean
}

export interface CommanderSnapshot {
  rev: number
  serverTime: number
  binding: BindingView['binding']
  commanderStatus: CommanderStatus
  panel: 'present' | 'absent'
  counts: Record<string, number>
  tasks: TaskView[]
  archiveSummary: { archivedCount: number; cancelledCount: number }
  workSessions: Array<{ sessionId: string; taskId: string; title?: string }>
  workspaces: WorkspaceView[]
  pendingDispatch: unknown
  metrics: { injections: number; deduped: number; pendingSkipped: number; injectFailures: number; projectionUnavailable: number }
  commanderBusy: boolean
  messages: CommanderMessage[]
  /** M4 加法字段：原生壳进程状态。 */
  nativeShell?: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped'
  /** R1 加法字段：轮换状态（只读；关闭时仍返回）。 */
  rotation?: RotationView
  /** R1 加法字段：退役指挥官（≤10，retiredAt 倒序）。 */
  formerCommanders?: FormerCommander[]
}

export interface SnapshotDeps {
  ctx: CordisContext
  stores: StoreSet
  binding: BindingView
  messages: CommanderMessage[]
  commanderBusy: boolean
  rev: number
  now?: () => number
  pendingDispatch?: unknown
  /** M3：注入/去重/跳过/失败/投影不可用计数（来自 injector，内存）。 */
  metrics?: { injections: number; deduped: number; pendingSkipped: number; injectFailures: number; projectionUnavailable: number }
  /** R1：轮换视图与退役指挥官。 */
  rotation?: RotationView
  formerCommanders?: FormerCommander[]
}

const STATUS_KEYS = ['draft', 'proposed', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled', 'archived'] as const

async function registryWorkspaces(ctx: CordisContext): Promise<Array<{ id: string; name: string; path: string }>> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  if (registry?.list === undefined) return []
  try {
    const list = await registry.list()
    return list.map((item) => ({ id: item.id, name: item.name ?? item.title ?? item.id, path: item.path }))
  } catch {
    return []
  }
}

/** 快照 workspaces = 注册表全部工作区 × 已存配置（未存 → 默认：allowed=false/summary=''/policy=inherit），按 name 升序。 */
export async function buildWorkspaceViews(ctx: CordisContext, stores: StoreSet): Promise<WorkspaceView[]> {
  const stored = new Map(stores.workspaces.list().map((record: WorkspaceRecord) => [record.id, record]))
  const registered = await registryWorkspaces(ctx)
  const rows: WorkspaceView[] = []
  const seen = new Set<string>()
  for (const item of registered) {
    seen.add(item.id)
    const record = stored.get(item.id)
    rows.push({
      id: item.id,
      name: item.name,
      path: item.path,
      allowed: record?.allowed ?? false,
      summary: record?.summary ?? '',
      policy: record?.capabilityPolicy.mode ?? 'inherit',
      lastSelection: null,
    })
  }
  for (const record of stored.values()) {
    if (seen.has(record.id)) continue
    rows.push({
      id: record.id,
      name: record.name || record.id,
      path: record.path,
      allowed: record.allowed,
      summary: record.summary,
      policy: record.capabilityPolicy.mode,
      lastSelection: null,
    })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

/** 任务记录 → 看板行（snapshot 与 SSE `task.updated` 共用，保证两端字段一致）。 */
export function buildTaskView(task: TaskRecord, at = Date.now(), dependencies?: { lookup?: (id: string) => TaskRecord | undefined; pendingDispatchTaskId?: string }): TaskView {
  const lookup = dependencies?.lookup ?? (() => undefined)
  const waiting = waitingFor(task, lookup)
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    workspaceIds: task.workspaceIds ?? (task.workspaceId !== '' ? [task.workspaceId] : []),
    priority: task.priority,
    round: task.round ?? 1,
    pendingContinue: task.pendingInstruction !== undefined,
    ...(task.primarySessionId !== undefined ? { primarySessionId: task.primarySessionId } : {}),
    sessionCount: task.assignments.length,
    acceptanceCount: task.acceptance.length,
    evidenceInsufficientCount: task.acceptance.filter((item) => item.state === 'insufficient').length,
    stale: taskIsStale(task, at),
    ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
    lastActivityAt: task.lastActivityAt,
    capability: capabilitySummary(task),
    updatedAt: task.updatedAt,
    dependsOn: task.dependsOn ?? [],
    waitingFor: waiting,
    ready: isReady(task, lookup),
    pendingDispatch: dependencies?.pendingDispatchTaskId === task.id,
  }
}

/** 任务状态计数（快照与 SSE `tasks.changed` 共用；含 archived，口径一致）。 */
export function countTaskStatuses(tasks: readonly TaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(STATUS_KEYS.map((key) => [key, 0]))
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
  return counts
}

export async function buildSnapshot(deps: SnapshotDeps): Promise<CommanderSnapshot> {
  const now = deps.now ?? (() => Date.now())
  const at = now()
  const allTasks = deps.stores.tasks.list()
  // 契约 §2.3：tasks 默认只含非 archived（≤200，updatedAt 倒序）；回收站走 GET /commander/archive。
  const tasks = allTasks
    .filter((task) => task.status !== 'archived')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SNAPSHOT_TASKS_MAX)
  const counts = countTaskStatuses(allTasks)
  const lookup = (id: string): TaskRecord | undefined => allTasks.find((task) => task.id === id)
  const pendingDispatchTaskId = (deps.pendingDispatch as { taskId?: unknown } | null | undefined)?.taskId
  const pendingTaskId = typeof pendingDispatchTaskId === 'string' ? pendingDispatchTaskId : undefined
  const archiveSummary = {
    archivedCount: allTasks.filter((task) => task.status === 'archived').length,
    cancelledCount: allTasks.filter((task) => task.status === 'cancelled').length,
  }
  return {
    rev: deps.rev,
    serverTime: now(),
    binding: deps.binding.binding,
    commanderStatus: deps.binding.status,
    panel: panelPresence(deps.ctx),
    counts,
    tasks: tasks.map((task) => buildTaskView(task, at, { lookup, ...(pendingTaskId !== undefined ? { pendingDispatchTaskId: pendingTaskId } : {}) })),
    archiveSummary,
    workSessions: deps.stores.sessions
      .list()
      .filter((link) => link.role === 'work' && link.taskId !== '')
      .slice(0, WORK_SESSIONS_MAX)
      .map((link) => ({ sessionId: link.sessionId, taskId: link.taskId })),
    workspaces: await buildWorkspaceViews(deps.ctx, deps.stores),
    pendingDispatch: deps.pendingDispatch ?? null,
    metrics: deps.metrics ?? { injections: 0, deduped: 0, pendingSkipped: 0, injectFailures: 0, projectionUnavailable: 0 },
    commanderBusy: deps.commanderBusy,
    messages: deps.messages,
    ...(deps.rotation !== undefined ? { rotation: deps.rotation } : {}),
    ...(deps.formerCommanders !== undefined ? { formerCommanders: deps.formerCommanders } : {}),
  }
}
