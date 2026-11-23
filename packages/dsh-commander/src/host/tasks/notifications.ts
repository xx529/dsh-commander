// 依赖就绪/受阻提醒（`task-state-machine-final.md` §6.3/§6.4）。
// Host 只提醒 commander，不自动派发、不自动改后继状态；一次只投一条 [task-unblocked]，
// 下一条在 commander_task_dispatch 成功/拒绝后 pump。投递失败不写 dependencyNotifiedAt，留待下次重试。
import type { TaskRecord } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'
import type { Deliverer } from '../session/deliver.ts'
import { DeliverError } from '../session/deliver.ts'
import { VersionConflictError } from '../store/base.ts'
import { dependentsOf, isReady } from './dependencies.ts'

export interface DependencyNotifierDeps {
  stores: StoreSet
  deliverer: Pick<Deliverer, 'deliverContextMessage'>
  now?: () => number
  logger?: { warn?: (message: string) => void }
  /** 有全局未决确认卡时不投新提醒，避免把旧卡顶掉。 */
  hasPendingDispatch?: () => boolean
}

export interface DependencyNotifier {
  /** accept 首次成功后：把 ready 的后继入队并投一条。 */
  afterAccepted(taskId: string): Promise<void>
  /** cancel/archive(review) 后：对仍在 draft/proposed 的后继注入 [task-dependency-blocked]。 */
  afterDependencyInvalidated(taskId: string): Promise<void>
  /** set_dependencies/recover/restore 后：把 ready 的后继入队并投一条。 */
  afterTasksChanged(taskId?: string): Promise<void>
  /** dispatch 成功/拒绝后：投下一条（若有）。 */
  afterDispatchSettled(): Promise<void>
  /** Host 启动补一次：ready 且 dependencyNotifiedAt 缺省的任务。 */
  backfill(): Promise<void>
  pump(): Promise<void>
  pending(): number
  dispose(): void
}

interface QueueEntry {
  taskId: string
  /** accept 触发时记录来源，用于提醒文案；backfill 时缺省。 */
  acceptedTaskId?: string
}

export function buildUnblockedText(task: TaskRecord, lookup: (id: string) => TaskRecord | undefined, acceptedTaskId?: string): string {
  const deps = task.dependsOn ?? []
  const lines = [`[task-unblocked] taskId=${task.id} status=${task.status}`]
  if (acceptedTaskId !== undefined && acceptedTaskId !== '') {
    const accepted = lookup(acceptedTaskId)
    lines.push(`依赖任务 ${accepted?.title ?? acceptedTaskId}（taskId=${acceptedTaskId}，标题「${accepted?.title ?? acceptedTaskId}」）已验收通过；${task.id} 已满足依赖。`)
  } else {
    lines.push('依赖已全部验收通过；本任务已满足依赖。')
  }
  lines.push(`请调用 commander_task_dispatch(taskId=${task.id}, requestId=<新ID>, instruction=<若需要>) 派发。`)
  lines.push('首次仍走确认（或按 autoDispatch 配置自动派发）。本次只提醒，不改任务状态。')
  lines.push('---', `dependsOn=${deps.join(',')}`)
  return lines.join('\n')
}

export function buildDependencyBlockedText(task: TaskRecord, invalidated: TaskRecord): string {
  const deps = task.dependsOn ?? []
  return [
    `[task-dependency-blocked] taskId=${task.id}`,
    `依赖任务 ${invalidated.title}（taskId=${invalidated.id}）已取消/归档（未验收），${task.id} 的依赖不会自动满足。`,
    `请决定：取消 ${task.id}、修改依赖，或新建替代任务；Host 未改动 ${task.id} 的状态。`,
    '---',
    `dependsOn=${deps.join(',')}`,
  ].join('\n')
}

export function createDependencyNotifier(deps: DependencyNotifierDeps): DependencyNotifier {
  const now = deps.now ?? (() => Date.now())
  const queue: QueueEntry[] = []
  const queued = new Set<string>()
  let pumping = false
  let disposed = false
  const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)

  const enqueue = (entries: readonly QueueEntry[]): void => {
    for (const entry of entries) {
      if (queued.has(entry.taskId)) continue
      queued.add(entry.taskId)
      queue.push(entry)
    }
  }

  const readyDependents = (taskId: string): QueueEntry[] => {
    const tasks = deps.stores.tasks.list()
    return dependentsOf(tasks, taskId)
      .filter((task) => (task.status === 'draft' || task.status === 'proposed') && (task.dependsOn?.length ?? 0) > 0 && isReady(task, lookup) && task.dependencyNotifiedAt === undefined)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((task) => ({ taskId: task.id, acceptedTaskId: taskId }))
  }

  const markNotified = async (taskId: string, at: number): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = deps.stores.tasks.get(taskId)
      if (current === undefined) return
      if (current.dependencyNotifiedAt !== undefined) return
      try {
        await deps.stores.tasks.update(taskId, (task) => ({ ...task, dependencyNotifiedAt: at }), current.version)
        return
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error
      }
    }
  }

  const pump = async (): Promise<void> => {
    if (pumping || disposed) return
    if (deps.hasPendingDispatch?.() === true) return
    pumping = true
    try {
      while (!disposed && queue.length > 0) {
        const entry = queue[0] as QueueEntry
        queue.shift()
        queued.delete(entry.taskId)
        const task = deps.stores.tasks.get(entry.taskId)
        if (task === undefined || (task.status !== 'draft' && task.status !== 'proposed') || task.dependencyNotifiedAt !== undefined) continue
        if (!isReady(task, lookup)) continue
        const at = now()
        try {
          await deps.deliverer.deliverContextMessage(buildUnblockedText(task, lookup, entry.acceptedTaskId), `task-unblocked-${task.id}-${String(at)}`, {
            kind: 'commander-task-unblocked',
            summary: '依赖已满足，可派发',
          })
          await markNotified(task.id, at)
          return // 一次只投一条；下一条等 dispatch 结算后再 pump
        } catch (error) {
          // 失败留在队首，下一次 accept/启动重试；不写 dependencyNotifiedAt。
          queue.unshift(entry)
          queued.add(entry.taskId)
          const message = error instanceof DeliverError ? error.message : String((error as Error)?.message ?? error)
          deps.logger?.warn?.(`[commander] task-unblocked delivery failed: ${message}`)
          return
        }
      }
    } finally {
      pumping = false
    }
  }

  const notifyBlocked = async (source: TaskRecord): Promise<void> => {
    const tasks = deps.stores.tasks.list()
    const dependents = dependentsOf(tasks, source.id)
      .filter((task) => task.status === 'draft' || task.status === 'proposed')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const task of dependents) {
      try {
        await deps.deliverer.deliverContextMessage(buildDependencyBlockedText(task, source), `task-dependency-blocked-${task.id}-${String(now())}`, {
          kind: 'commander-task-dependency-blocked',
          summary: '依赖任务已取消/归档',
        })
      } catch (error) {
        deps.logger?.warn?.(`[commander] task-dependency-blocked delivery failed: ${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  return {
    async afterAccepted(taskId) {
      enqueue(readyDependents(taskId))
      await pump()
    },
    async afterDependencyInvalidated(taskId) {
      const source = deps.stores.tasks.get(taskId)
      if (source === undefined) return
      await notifyBlocked(source)
    },
    async afterTasksChanged(taskId) {
      if (taskId !== undefined) {
        // 任务本身也可能刚变成 ready（例如被恢复/改依赖），以及它的依赖刚变化。
        const task = deps.stores.tasks.get(taskId)
        if (task !== undefined && (task.status === 'draft' || task.status === 'proposed') && (task.dependsOn?.length ?? 0) > 0 && isReady(task, lookup) && task.dependencyNotifiedAt === undefined) {
          enqueue([{ taskId }])
        }
        enqueue(readyDependents(taskId))
      } else {
        enqueue(deps.stores.tasks.list()
          .filter((task) => (task.status === 'draft' || task.status === 'proposed') && (task.dependsOn?.length ?? 0) > 0 && isReady(task, lookup) && task.dependencyNotifiedAt === undefined)
          .map((task) => ({ taskId: task.id })))
      }
      await pump()
    },
    async afterDispatchSettled() {
      await pump()
    },
    async backfill() {
      enqueue(deps.stores.tasks.list()
        .filter((task) => (task.status === 'draft' || task.status === 'proposed') && (task.dependsOn?.length ?? 0) > 0 && isReady(task, lookup) && task.dependencyNotifiedAt === undefined)
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .map((task) => ({ taskId: task.id })))
      await pump()
    },
    pump,
    pending: () => queue.length,
    dispose() {
      disposed = true
      queue.length = 0
      queued.clear()
    },
  }
}
