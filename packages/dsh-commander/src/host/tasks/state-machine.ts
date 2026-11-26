// 任务状态机唯一迁移入口（`docs/architecture/task-state-machine-final.md` §3/§7）。
// 职责：迁移图 + actor 权限 + 守卫（review 验收、queued 会话、blocked reason、blocked→proposed 仅 round1、
// done/archived 专用 actor）、副作用（清 block/pending、archivedFrom、时间线类型）。
// 所有写任务状态的入口（dispatch/report/turn/update/accept/archive/restore/cancel）都必须经过这里。
import type { TaskRecord, TaskStatus, TaskTimelineItem } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'
import { VersionConflictError } from '../store/base.ts'

export type TransitionActor =
  | 'host_dispatch'
  | 'host_turn'
  | 'commander_tool'
  | 'commander_accept'
  | 'user_accept'
  | 'user_archive'
  | 'user_restore'
  | 'user_cancel'

export interface TransitionContext {
  actor: TransitionActor
  acceptanceCount?: number
  hasPrimarySession?: boolean
  blockReason?: string
  round?: number
  hasAcceptanceHistory?: boolean
}

export type TransitionFailureCode = 'task_state' | 'invalid_status' | 'precondition'

export interface TransitionEffects {
  /** 离开 blocked：清 block。 */
  clearBlock: boolean
  /** 进入 queued/blocked/cancelled/archived：清看板续派批注。 */
  clearPendingInstruction: boolean
  /** 进入 archived：把原状态写进 archivedFrom。 */
  stampArchivedFrom: boolean
  /** review→queued：上一轮验收进历史（dispatch 自定义 mutate 也会处理）。 */
  archiveAcceptanceHistory: boolean
  /** 离开 archived：清 archivedAt/archivedFrom。 */
  clearArchivedFields: boolean
  /** 离开 archived：清依赖提醒去重标记。 */
  clearDependencyNotifiedAt: boolean
  timelineType: TaskTimelineItem['type']
}

export type TransitionCheck =
  | { ok: true; effects: TransitionEffects }
  | { ok: false; code: TransitionFailureCode; message: string }

/** 允许的边 → actor 白名单。未列出的边一律禁止。 */
const EDGE_ACTORS: Readonly<Record<string, readonly TransitionActor[]>> = {
  'draft>proposed': ['host_dispatch'],
  'draft>queued': ['host_dispatch'],
  'draft>blocked': ['host_dispatch', 'commander_tool'],
  'draft>cancelled': ['commander_tool', 'user_cancel'],
  'proposed>queued': ['host_dispatch'],
  'proposed>blocked': ['host_dispatch', 'commander_tool'],
  'proposed>cancelled': ['commander_tool', 'user_cancel'],
  'queued>running': ['host_turn', 'commander_tool'], // commander_tool：report(no_progress) 的机械回写
  'queued>review': ['commander_tool'],
  'queued>blocked': ['commander_tool'],
  'queued>cancelled': ['commander_tool', 'user_cancel'],
  'running>running': ['commander_tool'],
  'running>review': ['commander_tool'],
  'running>blocked': ['commander_tool'],
  'running>cancelled': ['commander_tool', 'user_cancel'],
  'blocked>running': ['host_turn', 'commander_tool'],
  'blocked>review': ['commander_tool'],
  'blocked>proposed': ['commander_tool'],
  'blocked>cancelled': ['commander_tool', 'user_cancel'],
  'review>queued': ['host_dispatch'],
  'review>blocked': ['host_dispatch'],
  'review>done': ['user_accept', 'commander_accept'],
  'review>cancelled': ['commander_tool', 'user_cancel'],
  'review>archived': ['user_archive'],
  'done>archived': ['user_archive'],
  'cancelled>archived': ['user_archive'],
  'archived>draft': ['user_restore'],
  'archived>review': ['user_restore'],
  'archived>done': ['user_restore'],
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'cancelled', 'archived'])

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status)
}

/** 状态对应的默认时间线类型（写入口可覆盖）。 */
function timelineTypeOf(to: TaskStatus): TaskTimelineItem['type'] {
  if (to === 'review') return 'report'
  if (to === 'done') return 'accept'
  return 'status'
}

function effectsOf(from: TaskStatus, to: TaskStatus): TransitionEffects {
  return {
    clearBlock: from === 'blocked' && to !== 'blocked',
    clearPendingInstruction: to === 'queued' || to === 'blocked' || to === 'cancelled' || to === 'archived' || from === 'archived',
    stampArchivedFrom: to === 'archived',
    archiveAcceptanceHistory: from === 'review' && to === 'queued',
    clearArchivedFields: from === 'archived' && to !== 'archived',
    clearDependencyNotifiedAt: from === 'archived' && to !== 'archived',
    timelineType: timelineTypeOf(to),
  }
}

/**
 * 校验一次状态迁移。同一状态返回 ok（调用方据此决定是否 no-op）；
 * 其余必须命中迁移图 + actor 白名单 + 守卫。
 */
export function checkTransition(task: TaskRecord, to: TaskStatus, ctx: TransitionContext): TransitionCheck {
  if (task.status === to) return { ok: true, effects: effectsOf(task.status, to) }
  const actors = EDGE_ACTORS[`${task.status}>${to}`]
  if (actors === undefined) {
    return { ok: false, code: 'invalid_status', message: `cannot transition ${task.status} -> ${to}` }
  }
  if (!actors.includes(ctx.actor)) {
    return { ok: false, code: 'task_state', message: `actor '${ctx.actor}' cannot move ${task.status} -> ${to}` }
  }
  const acceptanceCount = ctx.acceptanceCount ?? task.acceptance.length
  const round = ctx.round ?? task.round ?? 1
  const hasAcceptanceHistory = ctx.hasAcceptanceHistory ?? (task.acceptanceHistory?.length ?? 0) > 0
  if (to === 'review' && ctx.actor !== 'user_restore' && acceptanceCount < 1) {
    return { ok: false, code: 'precondition', message: 'review requires at least 1 acceptance item' }
  }
  if (to === 'queued' && !(ctx.hasPrimarySession ?? (task.primarySessionId !== undefined && task.primarySessionId !== ''))) {
    return { ok: false, code: 'precondition', message: 'queued requires task.primarySessionId' }
  }
  if (to === 'blocked' && (ctx.blockReason ?? task.block?.reason ?? '').trim() === '') {
    return { ok: false, code: 'precondition', message: 'blocked requires a non-empty block reason' }
  }
  if (task.status === 'blocked' && to === 'proposed' && (round !== 1 || hasAcceptanceHistory)) {
    return { ok: false, code: 'precondition', message: 'blocked -> proposed is only allowed on round 1 without acceptance history' }
  }
  if (task.status === 'blocked' && to === 'running' && !(ctx.hasPrimarySession ?? (task.primarySessionId !== undefined && task.primarySessionId !== ''))) {
    return { ok: false, code: 'precondition', message: 'blocked -> running requires task.primarySessionId' }
  }
  return { ok: true, effects: effectsOf(task.status, to) }
}

/** restore 的目标状态：archivedFrom 缺省/未知 → draft（cancelled 来源也回 draft）。 */
export function restoreTargetOf(task: Pick<TaskRecord, 'archivedFrom'>): TaskStatus {
  if (task.archivedFrom === 'review') return 'review'
  if (task.archivedFrom === 'done') return 'done'
  return 'draft'
}

export interface TransitionTaskDeps {
  stores: StoreSet
  now?: () => number
  onTaskChanged?: (task: TaskRecord) => void
}

export interface TransitionTaskInput {
  taskId: string
  to: TaskStatus
  actor: TransitionActor
  context?: Omit<TransitionContext, 'actor'>
  /** CAS：与当前 version 不一致时返回 version_conflict，不落盘。 */
  expectedVersion?: number
  /** 额外写入（dispatch/report 的领域字段）；在状态/副作用之后合并。 */
  mutate?: (current: TaskRecord, at: number, effects: TransitionEffects) => Partial<TaskRecord>
  timelineText?: string | ((current: TaskRecord) => string)
  timelineType?: TaskTimelineItem['type']
  /** 时间线所属轮次；缺省读任务当前轮。 */
  round?: number
}

export type TransitionTaskResult =
  | { ok: true; task: TaskRecord; changed: boolean }
  | { ok: false; code: 'not_found' | TransitionFailureCode | 'version_conflict'; message: string }

export function effectsSummary(effects: TransitionEffects): string {
  const parts: string[] = []
  if (effects.clearBlock) parts.push('clear-block')
  if (effects.clearPendingInstruction) parts.push('clear-pending')
  if (effects.stampArchivedFrom) parts.push('archive-from')
  if (effects.archiveAcceptanceHistory) parts.push('archive-acceptance')
  return parts.join(',')
}

/**
 * 唯一任务状态写入口：读最新记录 → 校验迁移 → 应用状态 + 副作用 + 领域 mutate → version+1。
 * 版本冲突重试 3 次（每次重读并重新校验迁移）。
 */
export async function transitionTask(deps: TransitionTaskDeps, input: TransitionTaskInput): Promise<TransitionTaskResult> {
  const now = deps.now ?? (() => Date.now())
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = deps.stores.tasks.get(input.taskId)
    if (current === undefined) return { ok: false, code: 'not_found', message: `task '${input.taskId}' not found` }
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      return { ok: false, code: 'version_conflict', message: `expected revision ${input.expectedVersion}, current ${current.version}` }
    }
    if (current.status === input.to) return { ok: true, task: current, changed: false }
    const context: TransitionContext = {
      actor: input.actor,
      acceptanceCount: current.acceptance.length,
      hasPrimarySession: current.primarySessionId !== undefined && current.primarySessionId !== '',
      round: current.round ?? 1,
      hasAcceptanceHistory: (current.acceptanceHistory?.length ?? 0) > 0,
      ...input.context,
    }
    const check = checkTransition(current, input.to, context)
    if (!check.ok) return check
    const effects = check.effects
    const at = now()
    const next: TaskRecord = {
      ...current,
      status: input.to,
      updatedAt: at,
      lastActivityAt: at,
    }
    if (effects.clearBlock) delete next.block
    if (effects.clearPendingInstruction) delete next.pendingInstruction
    if (effects.clearArchivedFields) {
      delete next.archivedAt
      delete next.archivedFrom
    }
    if (effects.clearDependencyNotifiedAt) delete next.dependencyNotifiedAt
    if (effects.stampArchivedFrom) next.archivedFrom = current.status
    const round = input.round ?? current.round ?? 1
    const text = typeof input.timelineText === 'function'
      ? input.timelineText(current)
      : input.timelineText ?? `状态 ${current.status} -> ${input.to}`
    const extra = input.mutate?.(current, at, effects) ?? {}
    Object.assign(next, extra)
    // 领域 mutate 显式给 undefined = 删除该可选字段（dispatch 续派清报告/材料）。
    for (const key of Object.keys(extra)) {
      if ((extra as Record<string, unknown>)[key] === undefined) delete (next as unknown as Record<string, unknown>)[key]
    }
    if (!('timeline' in extra)) {
      next.timeline = [...current.timeline, {
        at,
        type: input.timelineType ?? effects.timelineType,
        text,
        round,
      }].slice(-100)
    }
    try {
      const updated = await deps.stores.tasks.update(input.taskId, () => next, current.version)
      deps.onTaskChanged?.(updated)
      return { ok: true, task: updated, changed: true }
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error
    }
  }
  return { ok: false, code: 'version_conflict', message: 'task version changed during transition' }
}
