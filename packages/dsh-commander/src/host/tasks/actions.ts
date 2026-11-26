// M3/M5 人专用动作：accept（review→done）与 requestContinue（看板继续派发请求）。
// 只由界面路由触发；不注册为模型工具（m2m3-contract-patch §3.4、m5-continue-dispatch §8）。
import { REWORK_COMMENT_MAX } from '../config.ts'
import type { CordisContext, SessionControllerService } from '../dsh-types.ts'
import type { TaskRecord } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'
import { appendTimeline } from '../store/base.ts'
import type { Deliverer } from '../session/deliver.ts'
import { DeliverError } from '../session/deliver.ts'
import { transitionTask } from './state-machine.ts'
import type { DependencyNotifier } from './notifications.ts'

export type TaskActionResult =
  | { ok: true; task: TaskRecord; duplicate: boolean }
  | { ok: false; kind: 'not_found' | 'conflict' | 'invalid_request' | 'delivery_failed'; message: string }

export interface ContinueActionResult {
  ok: true
  task: TaskRecord
  notified: boolean
  duplicate: boolean
}
export type ContinueRequestResult = ContinueActionResult | { ok: false; kind: 'not_found' | 'conflict' | 'invalid_request' | 'delivery_failed'; message: string }

export interface TaskActionDeps {
  ctx: CordisContext
  stores: StoreSet
  now?: () => number
  logger?: { warn?: (message: string) => void }
  /** 写成功后通知 UI（整行 task.updated + tasks.changed 计数）。 */
  onTaskChanged?: (task: TaskRecord) => void
  /** 继续派发请求投递到指挥官；缺省时返回 delivery_failed（测试可注入）。 */
  deliverer?: Pick<Deliverer, 'deliverContextMessage'>
  /** 该任务是否已有待确认派发；有则拒绝继续派发请求，避免与确认卡竞态。 */
  hasPendingDispatch?: (taskId: string) => boolean
  /** accept 成功后清理该任务的未决确认。 */
  onTaskSettled?: (taskId: string) => void
  /** 依赖提醒：accept 首次成功后提醒 ready 的后继（不自动派发）。 */
  dependencyNotifier?: Pick<DependencyNotifier, 'afterAccepted'>
}

export interface AcceptOptions {
  /** 验收交接说明（≤1000 字）；空白视为无。 */
  note?: string
  /** 验收来源：人（缺省）或指挥官工具。 */
  actor?: 'user' | 'commander'
}

export type AcceptDeps = Omit<Pick<TaskActionDeps, 'stores' | 'now' | 'onTaskChanged' | 'onTaskSettled' | 'dependencyNotifier'>, 'dependencyNotifier'> & {
  dependencyNotifier?: Partial<Pick<DependencyNotifier, 'afterAccepted'>>
}

/**
 * accept（review→done）的唯一实现：人路由与 commander_task_accept 共用。
 * 交接说明 acceptNote 与 acceptedBy 在同一次 CAS 写入里落库；
 * 幂等（已 done）时不覆盖已有 acceptNote，也不重复注入依赖提醒。
 */
export async function performAccept(deps: AcceptDeps, taskId: string, options: AcceptOptions = {}): Promise<TaskActionResult> {
  const now = deps.now ?? (() => Date.now())
  const noteText = typeof options.note === 'string' ? options.note.trim() : ''
  if (noteText.length > REWORK_COMMENT_MAX) {
    return { ok: false, kind: 'invalid_request', message: `note exceeds ${REWORK_COMMENT_MAX} characters` }
  }
  const byCommander = options.actor === 'commander'
  const task = deps.stores.tasks.get(taskId)
  if (task === undefined) return { ok: false, kind: 'not_found', message: `task '${taskId}' not found` }
  if (task.status === 'done') return { ok: true, task, duplicate: true }
  if (task.status !== 'review') return { ok: false, kind: 'conflict', message: `只能 review→done，当前 ${task.status}` }
  // 人已确认验收：acceptance 为空只可能是历史脏数据（旧版 commander_task_update 允许 `status=review` 无验收项，
  // 写入侧已修）。这里不再 409 卡住人，改为在 timeline 明确标注，避免任务永远无法收尾。
  const emptyAcceptance = task.acceptance.length < 1
  const round = task.round ?? 1
  const digest = noteText !== '' ? `，交接说明：${noteText.slice(0, 200)}` : ''
  const source = byCommander ? '（指挥官验收）' : ''
  const timelineText = emptyAcceptance
    ? `第 ${round} 轮验收通过（无验收项：历史数据）${source}${digest}`
    : `第 ${round} 轮验收通过${source}${digest}`
  const transition = await transitionTask({ stores: deps.stores, now, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) }, {
    taskId,
    to: 'done',
    actor: byCommander ? 'commander_accept' : 'user_accept',
    timelineType: 'accept',
    round,
    timelineText,
    mutate: (_current, at) => ({
      acceptedBy: byCommander ? ('commander' as const) : ('user' as const),
      ...(noteText !== '' ? { acceptNote: { text: noteText, at, round } } : {}),
    }),
  })
  if (!transition.ok) return { ok: false, kind: 'conflict', message: transition.code === 'not_found' ? `task '${taskId}' not found` : transition.message }
  deps.onTaskSettled?.(taskId)
  // 首次成功才提醒；幂等重复 accept 不重复注入 [task-unblocked]。
  if (transition.changed) await deps.dependencyNotifier?.afterAccepted?.(taskId)
  return { ok: true, task: transition.task, duplicate: !transition.changed }
}

const CONTINUE_REQUEST_TTL_MS = 5 * 60 * 1000

export function buildContinueRequestText(task: TaskRecord, comment: string): string {
  const round = task.round ?? 1
  return [
    `[task-continue] taskId=${task.id} round=${round} status=review`,
    `用户在任务看板对「${task.title}」请求继续派发/返工：`,
    comment,
    `请调用 commander_task_dispatch(taskId, prompt=<你写给工作会话的全文，必须包含上面批注原文>, requestId=<新ID>) 继续派发；默认推荐原会话，也可以改选新工作区/新会话。确认后任务进入第 ${round + 1} 轮。`,
    '---',
    `requestId=continue-${task.id}-${round + 1}`,
  ].join('\n')
}

export function createTaskActions(deps: TaskActionDeps) {
  const now = deps.now ?? (() => Date.now())
  const controller = (): SessionControllerService | undefined => deps.ctx.get('sessionController') as SessionControllerService | undefined
  const continueRequests = new Map<string, number>()

  const pruneContinueRequests = (at: number): void => {
    for (const [key, seenAt] of continueRequests) {
      if (at - seenAt > CONTINUE_REQUEST_TTL_MS) continueRequests.delete(key)
    }
  }

  const writeTask = async (taskId: string, mutate: (current: TaskRecord) => TaskRecord): Promise<TaskRecord | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = deps.stores.tasks.get(taskId)
      if (current === undefined) return null
      try {
        return await deps.stores.tasks.update(taskId, mutate, current.version)
      } catch (error) {
        if (!(error instanceof Error) || (error as { name?: string }).name !== 'VersionConflictError') throw error
      }
    }
    return null
  }

  return {
    async accept(taskId: string, options: AcceptOptions = {}): Promise<TaskActionResult> {
      return performAccept(deps, taskId, options)
    },

    /**
     * 看板「继续派发」：只写 pendingInstruction + timeline 并通知指挥官；
     * 不直接 prompt 工作会话、不改任务状态。真正的派发由 commander_task_dispatch 确认路径完成。
     */
    async requestContinue(taskId: string, commentRaw?: unknown, requestIdRaw?: unknown): Promise<ContinueRequestResult> {
      const comment = typeof commentRaw === 'string' ? commentRaw.trim() : commentRaw === undefined ? '' : String(commentRaw).trim()
      if (comment.length > REWORK_COMMENT_MAX) {
        return { ok: false, kind: 'invalid_request', message: `comment exceeds ${REWORK_COMMENT_MAX} characters` }
      }
      const task = deps.stores.tasks.get(taskId)
      if (task === undefined) return { ok: false, kind: 'not_found', message: `task '${taskId}' not found` }
      if (task.status !== 'review') return { ok: false, kind: 'conflict', message: `只能对 review 任务继续派发，当前 ${task.status}` }
      if (deps.hasPendingDispatch?.(taskId) === true) {
        return { ok: false, kind: 'conflict', message: '该任务正在等待派发确认，请先处理确认卡或取消确认' }
      }
      const requestId = typeof requestIdRaw === 'string' && requestIdRaw !== '' ? requestIdRaw : undefined
      const at = now()
      if (requestId !== undefined) {
        pruneContinueRequests(at)
        const seen = continueRequests.get(requestId)
        if (seen !== undefined) return { ok: true, task, notified: false, duplicate: true }
      }
      const text = comment !== '' ? comment : '用户请求继续派发（无批注）'
      const updated = await writeTask(taskId, (current) => ({
        ...current,
        pendingInstruction: { text, at, source: 'rework' },
        updatedAt: at,
        lastActivityAt: at,
        timeline: appendTimeline(current.timeline, {
          at,
          type: 'continue_request',
          round: (current.round ?? 1) + 1,
          text: `用户请求继续派发：${text.slice(0, 200)}`,
        }),
      }))
      if (updated === null) return { ok: false, kind: 'conflict', message: 'task version conflict' }
      deps.onTaskChanged?.(updated)

      const deliverer = deps.deliverer
      if (deliverer === undefined) return { ok: false, kind: 'delivery_failed', message: 'commander deliverer is unavailable' }
      const injectionText = buildContinueRequestText(updated, text)
      try {
        await deliverer.deliverContextMessage(injectionText, requestId ?? `continue-${taskId}-${at}`, {
          kind: 'commander-task-continue',
          summary: '任务继续派发请求',
        })
      } catch (error) {
        deps.logger?.warn?.(`[commander] continue request delivery failed: ${String((error as Error)?.message ?? error)}`)
        const message = error instanceof DeliverError ? error.message : String((error as Error)?.message ?? error).slice(0, 200)
        return { ok: false, kind: 'delivery_failed', message }
      }
      if (requestId !== undefined) continueRequests.set(requestId, at)
      return { ok: true, task: updated, notified: true, duplicate: false }
    },
  }
}

export type TaskActions = ReturnType<typeof createTaskActions>
