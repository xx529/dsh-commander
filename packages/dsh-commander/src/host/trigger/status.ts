// M1 trigger（收敛版）：只做 turn/start|turn/end 的机械状态更新，不注入、不做 pending/去重（M3）。
// 契约：implementation-plan §9.4、m1-contract-patch §5。
import type { CordisContext, SessionEventLike } from '../dsh-types.ts'
import type { StoreSet } from '../store/index.ts'
import type { TaskRecord, TaskStatus } from '../schema.ts'
import { readSessionEvents } from '../session/session-records.ts'
import { transitionTask } from '../tasks/state-machine.ts'

export interface WorkStatusDeps {
  ctx: CordisContext
  stores: StoreSet
  now?: () => number
  /** 任务行变化后通知 UI（turn/end 也要发：否则看板/详情页只能等重启或重新打开）。 */
  onTaskChanged?: (task: TaskRecord) => void
}

export interface WorkStatusResult {
  taskId: string
  status: 'running' | 'queued'
  sessionStatus: 'running' | 'idle'
}

const turnOf = (event: SessionEventLike): number | null => {
  const turn = (event?.data as Record<string, unknown> | undefined)?.turn
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : null
}

/** 已结束的任务状态：历史 link 不再接收该会话的回合事件（会话可被重新 attach，link 会被覆盖）。 */
const CLOSED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'cancelled', 'archived'])

/**
 * 找到会话绑定（role=work）与其**仍活跃**的任务。
 *
 * sessions link 以 (workspaceId, sessionId) 为键、只存一个 taskId：同一会话被重新 attach 时会覆盖旧
 * link。prompt 在 link 写入之前发出，因此新派发的 `turn/start` 可能先到、且此时 link 仍指向旧任务。
 * 旧任务已终态（done/cancelled/archived）时必须当作"无 link"（交给孤儿补偿），否则回合事件会被
 * 记到已归档任务上，新任务永远停在 queued。
 */
export function findWorkLink(stores: StoreSet, sessionId: string): { link: ReturnType<StoreSet['sessions']['list']>[number]; taskId: string } | undefined {
  for (const link of stores.sessions.list()) {
    if (link.sessionId !== sessionId || link.role !== 'work') continue
    const task = stores.tasks.get(link.taskId)
    if (task === undefined || CLOSED_TASK_STATUSES.has(task.status)) continue
    // 旧轮次 link 不再参与状态跟踪（M5）：同一任务多会话/多工作区时只认当前轮。
    if ((link.round ?? 1) < (task.round ?? 1)) continue
    return { link, taskId: link.taskId }
  }
  return undefined
}

/** 处理一个 session/event（M1：只维护状态与 lastActivityAt，不注入任何消息）。 */
export async function handleWorkSessionEvent(deps: WorkStatusDeps, sessionId: string, event: SessionEventLike): Promise<WorkStatusResult | null> {
  const type = event.type
  if (type !== 'turn/start' && type !== 'turn/end') return null
  const found = findWorkLink(deps.stores, sessionId)
  if (found === undefined) return null
  const now = deps.now ?? (() => Date.now())
  const at = typeof event.time === 'number' ? event.time : now()
  const running = type === 'turn/start'
  // sessions link 状态维护：原子 patch（注入链路会并发写 lastInjected，整条 upsert 会互相覆盖）
  await deps.stores.sessions.patch(found.link.workspaceId, found.link.sessionId, (current) => ({
    ...current,
    status: running ? 'running' : 'idle',
  }))
  const task = deps.stores.tasks.get(found.taskId)
  let taskStatus: 'running' | 'queued' = task?.status === 'queued' || task?.status === 'blocked' ? (running ? 'running' : 'queued') : (task?.status as 'running' | 'queued') ?? 'queued'
  if (task !== undefined) {
    if (running && (task.status === 'queued' || task.status === 'blocked')) {
      // queued/blocked → running 也走统一迁移入口（清 block；状态真变化才写时间线）。
      const transition = await transitionTask(
        { stores: deps.stores, now: () => at, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) },
        { taskId: task.id, to: 'running', actor: 'host_turn', timelineText: '工作会话回合开始' },
      )
      if (transition.ok) taskStatus = transition.task.status as 'running' | 'queued'
    } else {
      const updated = await deps.stores.tasks.update(task.id, (current) => ({ ...current, lastActivityAt: at, updatedAt: at }), task.version)
      if (running) taskStatus = updated.status as 'running' | 'queued'
      deps.onTaskChanged?.(updated)
    }
  }
  void turnOf(event)
  return { taskId: found.taskId, status: taskStatus, sessionStatus: running ? 'running' : 'idle' }
}

/** 注册 session/event 监听（M1 只做状态更新；不注入、不取最后回复）。 */
export function subscribeWorkSessionStatus(deps: WorkStatusDeps): () => void {
  const handler = (...args: unknown[]): void => {
    const [sessionArg, eventArg] = args as [Record<string, unknown> | undefined, SessionEventLike | undefined]
    const sessionId = typeof sessionArg?.id === 'string' ? sessionArg.id : undefined
    if (sessionId === undefined || eventArg === undefined) return
    void handleWorkSessionEvent(deps, sessionId, eventArg).catch(() => undefined)
  }
  const disposable = deps.ctx.on('session/event', handler)
  return () => {
    try {
      disposable?.()
    } catch {
      /* disposer 幂等 */
    }
  }
}


/** 孤儿 turn/start 保留窗口（link 写入前的竞态事件）。 */
export const WORK_STATUS_ORPHAN_TTL_MS = 15_000
/** 启动回填：turn/start 允许早于 link.createdAt 的容差（prompt 先于 link 写入）。 */
const BACKFILL_TURN_START_SLACK_MS = 5_000

export interface WorkStatusTracker {
  subscribe(): () => void
  /** spawn 写 task queued + sessions link 之后调用：若此前已有孤儿 turn/start，补一次 queued→running。 */
  reconcile(taskId: string, sessionId: string): Promise<WorkStatusResult | null>
  /**
   * 启动回填：进程内错过的 turn/start（宿主重启、re-attach 竞态）不会重放；对仍是 queued 的任务读会话事件，
   * 若会话最后一个回合事件是 turn/start（回合仍在进行），补一次 queued→running。返回修正条数。
   */
  backfill(): Promise<number>
  handleEvent(sessionId: string, event: SessionEventLike): Promise<WorkStatusResult | null>
  dispose(): void
  orphanCount(): number
}

/**
 * M1 trigger（状态机部分）：处理 turn/start|turn/end 的机械状态更新。
 * H4：prompt 先启动回合、service 后写 task/link → turn/start 可能先到且找不到 task；这里暂存孤儿事件，
 * spawn 写完后 reconcile 补一次 running（不注入、不轮询、定时器仅清理内存）。
 * 同一会话被重新 attach 时 link 会覆盖旧任务，故 turn/start 也可能先到、落在旧 link 上：除了孤儿表，
 * 还记录「最近一次 turn/start」，reconcile 时二者任一命中都补 running。
 */
export function createWorkStatusTracker(deps: WorkStatusDeps): WorkStatusTracker {
  const now = deps.now ?? (() => Date.now())
  const orphans = new Map<string, { at: number; running: boolean }>()
  /** 会话最近一次 turn/start 的时间：即使事件被旧 link 吃掉（同一会话多任务 attach 的竞态），reconcile 也能补 running。 */
  const lastTurnStart = new Map<string, number>()
  const prune = (): void => {
    const at = now()
    for (const [sessionId, entry] of orphans) if (at - entry.at > WORK_STATUS_ORPHAN_TTL_MS) orphans.delete(sessionId)
    for (const [sessionId, at2] of lastTurnStart) if (at - at2 > WORK_STATUS_ORPHAN_TTL_MS) lastTurnStart.delete(sessionId)
  }
  const applyRunning = async (taskId: string, sessionId: string, at: number): Promise<WorkStatusResult | null> => {
    const task = deps.stores.tasks.get(taskId)
    if (task === undefined) return null
    if (task.status !== 'queued' && task.status !== 'blocked') {
      return { taskId, status: 'running', sessionStatus: 'running' }
    }
    const transition = await transitionTask(
      { stores: deps.stores, now: () => at, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) },
      { taskId, to: 'running', actor: 'host_turn', timelineText: '工作会话回合开始' },
    )
    if (!transition.ok) return null
    const existing = deps.stores.sessions.list().find((item) => item.sessionId === sessionId && item.taskId === taskId)
    if (existing !== undefined) {
      await deps.stores.sessions.patch(existing.workspaceId, existing.sessionId, (current) => ({ ...current, status: 'running' }))
    }
    return { taskId, status: 'running', sessionStatus: 'running' }
  }
  const tracker: WorkStatusTracker = {
    async handleEvent(sessionId, event) {
      const type = event?.type
      if (type !== 'turn/start' && type !== 'turn/end') return null
      if (type === 'turn/start') lastTurnStart.set(sessionId, now())
      const found = findWorkLink(deps.stores, sessionId)
      if (found === undefined) {
        if (type === 'turn/start') orphans.set(sessionId, { at: now(), running: true })
        return null
      }
      return handleWorkSessionEvent(deps, sessionId, event)
    },
    async reconcile(taskId, sessionId) {
      prune()
      const orphan = orphans.get(sessionId)
      const recentStart = lastTurnStart.get(sessionId)
      if (orphan === undefined && recentStart === undefined) return null
      orphans.delete(sessionId)
      lastTurnStart.delete(sessionId)
      return applyRunning(taskId, sessionId, now())
    },
    async backfill() {
      let repaired = 0
      for (const link of deps.stores.sessions.list()) {
        if (link.role !== 'work') continue
        const task = deps.stores.tasks.get(link.taskId)
        if (task === undefined || task.status !== 'queued') continue
        if ((link.round ?? 1) < (task.round ?? 1)) continue
        const events = await readSessionEvents(deps.ctx, link.sessionId)
        // 只认「本任务 link 写入前后 ±5s 内开始、且之后再无 turn/end」的回合：排队在别人回合后面的 brief
        // 不算 running；重启后遗留的未结束回合（会话已 abort）也不会被误判。
        const since = link.createdAt - BACKFILL_TURN_START_SLACK_MS
        let lastStartAt = -Infinity
        let lastEndAt = -Infinity
        for (const event of events) {
          const at = typeof event.time === 'number' ? event.time : undefined
          if (at === undefined) continue
          if (event.type === 'turn/start' && at >= since) lastStartAt = Math.max(lastStartAt, at)
          if (event.type === 'turn/end') lastEndAt = Math.max(lastEndAt, at)
        }
        if (lastStartAt === -Infinity || lastEndAt > lastStartAt) continue
        const repairedResult = await applyRunning(task.id, link.sessionId, now())
        if (repairedResult !== null) repaired += 1
      }
      return repaired
    },
    subscribe() {
      const handler = (...args: unknown[]): void => {
        const [sessionArg, eventArg] = args as [Record<string, unknown> | undefined, SessionEventLike | undefined]
        const sessionId = typeof sessionArg?.id === 'string' ? sessionArg.id : undefined
        if (sessionId === undefined || eventArg === undefined) return
        void tracker.handleEvent(sessionId, eventArg).catch(() => undefined)
      }
      const disposable = deps.ctx.on('session/event', handler)
      return () => {
        try {
          disposable?.()
        } catch {
          /* 幂等 */
        }
      }
    },
    dispose() {
      orphans.clear()
      lastTurnStart.clear()
    },
    orphanCount() {
      prune()
      return orphans.size
    },
  }
  return tracker
}
