// M2 看板 Host 半（m2m3-contract-patch §2.3–§2.7；task-state-machine-final §5.7/§8）：
// 人工 PATCH 只允许 priority/title → tasks + board_edits → 30s 一次性合并注入 [board-edit]；
// archive/restore 走统一迁移入口；stale 只读派生；任务详情 boardEdits 摘要。
// 状态推进不走看板 PATCH：accept/archive/restore/cancel 是人专用路由，其余由 commander 工具/宿主事件完成。
import { createHash } from 'node:crypto'
import { ARCHIVE_LIST_MAX, BOARD_EDIT_MERGE_MS, BOARD_EDITS_DETAIL_MAX, BOARD_TITLE_MAX, STALE_AFTER_MS } from '../config.ts'
import type { BoardEditRecord, Priority, TaskRecord, TaskStatus } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'
import type { CordisContext } from '../dsh-types.ts'
import type { Deliverer } from '../session/deliver.ts'
import { DeliverError } from '../session/deliver.ts'
import { appendTimeline, VersionConflictError } from '../store/base.ts'
import { transitionTask, restoreTargetOf } from '../tasks/state-machine.ts'
import type { DependencyNotifier } from '../tasks/notifications.ts'
import { stopTaskSessions } from '../tasks/stop-sessions.ts'

export type BoardField = 'priority' | 'title'

export const BOARD_PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']
const ARCHIVE_SOURCES: TaskStatus[] = ['review', 'done', 'cancelled']

export interface BoardServiceDeps {
  ctx: CordisContext
  stores: StoreSet
  deliverer: Pick<Deliverer, 'deliverContextMessage'>
  now?: () => number
  /** 合并窗口（测试可缩短；默认 30s）。 */
  mergeWindowMs?: number
  /** 通知 UI（SSE task.updated 等）。 */
  notifyChanged?: (taskId: string, status: TaskStatus) => void
  logger?: { warn?: (message: string) => void }
  /** 依赖提醒：archive(review) 后通知后继；restore 后检查 ready。 */
  dependencyNotifier?: Pick<DependencyNotifier, 'afterDependencyInvalidated' | 'afterTasksChanged'>
}

export interface BoardEditView {
  editId: string
  field: string
  before: unknown
  after: unknown
  at: number
  injectedAt: number | null
}

interface MergeRecord {
  taskId: string
  editIds: string[]
  before: Partial<Record<BoardField, unknown>>
  after: Partial<Record<BoardField, unknown>>
  timer: ReturnType<typeof setTimeout> | undefined
}

/** stale 只读派生：queued/running 且 now-lastActivityAt > 20min。 */
export function taskIsStale(task: TaskRecord, now: number): boolean {
  if (task.status !== 'queued' && task.status !== 'running') return false
  return now - task.lastActivityAt > STALE_AFTER_MS
}

export function boardEditInjectionKey(taskId: string, editIds: string[]): string {
  return createHash('sha1').update(`${taskId}\0${[...editIds].sort().join(',')}`).digest('hex')
}

/** [board-edit] 注入文本（逐字段 before→after；只同步最终态，不回滚用户改动）。 */
export function buildBoardEditText(task: TaskRecord, merged: MergeRecord): string {
  const lines = [`[board-edit] taskId=${task.id} by=user`]
  for (const field of ['title', 'priority'] as BoardField[]) {
    if (!(field in merged.after)) continue
    lines.push(`${field}: ${String(merged.before[field])} → ${String(merged.after[field])}`)
  }
  lines.push('请同步任务元数据与后续跟进，不要回滚用户改动。')
  const key = boardEditInjectionKey(task.id, merged.editIds)
  lines.push('---', `editIds=${merged.editIds.join(',')} injectionKey=${key}`)
  return lines.join('\n')
}

export interface PatchBoardInput {
  field: unknown
  value: unknown
  editId: unknown
  requestId?: unknown
}

export type PatchBoardResult =
  | { ok: true; task: TaskRecord; boardEdit: { editId: string; injectedAt: number | null }; duplicate: boolean }
  | { ok: false; conflict: true; message: string }
  | { ok: false; invalid: true; message: string; field?: string }

export type BoardTaskActionResult =
  | { ok: true; task: TaskRecord; duplicate: boolean }
  | { ok: false; conflict: true; message: string }
  | { ok: false; invalid: true; message: string }

export interface BoardService {
  patchTask(taskId: string, input: PatchBoardInput): Promise<PatchBoardResult>
  archiveTask(taskId: string): Promise<BoardTaskActionResult>
  restoreTask(taskId: string): Promise<BoardTaskActionResult>
  /** 人专用取消：先停 running/queued 会话，失败不落状态；清 pending/block。 */
  cancelTask(taskId: string): Promise<BoardTaskActionResult>
  listArchive(options: { limit?: number; cursor?: number }): { tasks: TaskRecord[]; nextCursor: number | null }
  detailBoardEdits(taskId: string): BoardEditView[]
  staleOf(task: TaskRecord): boolean
  /** 启动补注入一次（injectedAt 为空且 at<now 的 edit；失败不风暴）。 */
  backfill(): Promise<void>
  dispose(): void
  pendingMerges(): number
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export function createBoardService(deps: BoardServiceDeps): BoardService {
  const now = deps.now ?? (() => Date.now())
  const mergeWindowMs = deps.mergeWindowMs ?? BOARD_EDIT_MERGE_MS
  const merges = new Map<string, MergeRecord>()
  const disposers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false

  const clearMergeTimer = (record: MergeRecord): void => {
    if (record.timer !== undefined) {
      clearTimeout(record.timer)
      disposers.delete(record.timer)
      record.timer = undefined
    }
  }

  const markInjected = async (record: MergeRecord, injectedAt: number): Promise<void> => {
    const key = boardEditInjectionKey(record.taskId, record.editIds)
    for (let index = 0; index < record.editIds.length; index += 1) {
      const edit = deps.stores.boardEdits.get(record.editIds[index] as string)
      if (edit === undefined) continue
      await deps.stores.boardEdits.put({ ...edit, injectedAt, ...(index === 0 ? { injectionKey: key } : {}) })
    }
  }

  const flush = async (record: MergeRecord): Promise<void> => {
    if (disposed) return
    clearMergeTimer(record)
    merges.delete(record.taskId)
    const task = deps.stores.tasks.get(record.taskId)
    if (task === undefined) return
    const text = buildBoardEditText(task, record)
    const at = now()
    try {
      await deps.deliverer.deliverContextMessage(text, `board-edit-${boardEditInjectionKey(record.taskId, record.editIds).slice(0, 16)}`, {
        kind: 'commander-board-edit',
        summary: '看板人工改动',
      })
      await markInjected(record, at)
    } catch (error) {
      // 投递失败不重试风暴：保留 injectedAt 空，等下次编辑/下次启动补一次。
      deps.logger?.warn?.(`[commander] board-edit injection failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  const scheduleFlush = (record: MergeRecord): void => {
    clearMergeTimer(record)
    const timer = setTimeout(() => {
      void flush(record)
    }, mergeWindowMs)
    timer.unref?.()
    record.timer = timer
    disposers.add(timer)
  }

  const writeTask = async (taskId: string, mutate: (current: TaskRecord) => TaskRecord): Promise<TaskRecord | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = deps.stores.tasks.get(taskId)
      if (current === undefined) return null
      try {
        return await deps.stores.tasks.update(taskId, mutate, current.version)
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error
      }
    }
    return null
  }

  const service: BoardService = {
    async patchTask(taskId, input) {
      const field = asString(input.field)
      if (field === 'status') {
        return { ok: false, invalid: true, message: 'status 不能通过看板 PATCH 修改：请用 accept/archive/restore/cancel 路由或 commander 工具', field: 'field' }
      }
      if (field === undefined || !['priority', 'title'].includes(field)) {
        return { ok: false, invalid: true, message: 'field must be one of priority|title', field: 'field' }
      }
      const editId = asString(input.editId)
      if (editId === undefined) return { ok: false, invalid: true, message: 'editId is required', field: 'editId' }
      const task = deps.stores.tasks.get(taskId)
      if (task === undefined) return { ok: false, conflict: true, message: `task '${taskId}' not found` }
      // 幂等：同 editId 重复提交返回首次结果（不重复写/不重复注入）。
      const existing = deps.stores.boardEdits.get(editId)
      if (existing !== undefined) {
        const boardEdit: BoardEditView = {
          editId: existing.id,
          field: existing.field,
          before: existing.before,
          after: existing.after,
          at: existing.at,
          injectedAt: existing.injectedAt ?? null,
        }
        return { ok: true, task, boardEdit, duplicate: true }
      }
      const at = now()
      let before: unknown
      let after: unknown
      let next: TaskRecord
      if (field === 'priority') {
        const value = asString(input.value) as Priority | undefined
        if (value === undefined || !BOARD_PRIORITIES.includes(value)) {
          return { ok: false, invalid: true, message: `priority must be one of ${BOARD_PRIORITIES.join('|')}`, field: 'value' }
        }
        before = task.priority
        after = value
        next = { ...task, priority: value, updatedAt: at, timeline: appendTimeline(task.timeline, { at, type: 'user_edit', text: `用户改板：priority ${task.priority} → ${value}` }) }
      } else {
        const value = typeof input.value === 'string' ? input.value : ''
        if (value.length < 1 || value.length > BOARD_TITLE_MAX) {
          return { ok: false, invalid: true, message: `title length must be 1..${BOARD_TITLE_MAX}`, field: 'value' }
        }
        before = task.title
        after = value
        next = { ...task, title: value, updatedAt: at, timeline: appendTimeline(task.timeline, { at, type: 'user_edit', text: '用户改板：title 已更新' }) }
      }
      const updated = await writeTask(taskId, () => next)
      if (updated === null) return { ok: false, conflict: true, message: 'task version conflict' }
      const edit: BoardEditRecord = { v: 1, id: editId, taskId, field, before, after, actor: 'user', at }
      await deps.stores.boardEdits.put(edit)
      // 30s 合并：同任务多条 edit 合并为一条注入，只保留最终态。
      const merge = merges.get(taskId) ?? { taskId, editIds: [], before: {}, after: {}, timer: undefined }
      merge.editIds.push(editId)
      merge.before[field as BoardField] = merge.before[field as BoardField] ?? before
      merge.after[field as BoardField] = after
      merges.set(taskId, merge)
      scheduleFlush(merge)
      deps.notifyChanged?.(taskId, updated.status)
      return { ok: true, task: updated, boardEdit: { editId, injectedAt: null }, duplicate: false }
    },

    async cancelTask(taskId) {
      const task = deps.stores.tasks.get(taskId)
      if (task === undefined) return { ok: false, conflict: true, message: `task '${taskId}' not found` }
      if (task.status === 'cancelled') return { ok: true, task, duplicate: true }
      if (task.status === 'done' || task.status === 'archived') {
        return { ok: false, conflict: true, message: `已结束的任务不能取消（当前 ${task.status}）` }
      }
      const stop = await stopTaskSessions(deps.ctx, deps.stores, taskId, deps.logger?.warn)
      if (stop.failed.length > 0) {
        const detail = stop.failed.map((item) => `${item.sessionId}: ${item.message}`).join('; ').slice(0, 600)
        return { ok: false, conflict: true, message: `取消任务前停止工作会话失败：${detail}` }
      }
      const transition = await transitionTask({ stores: deps.stores, now, ...(deps.notifyChanged !== undefined ? { onTaskChanged: (row) => deps.notifyChanged?.(row.id, row.status) } : {}) }, {
        taskId,
        to: 'cancelled',
        actor: 'user_cancel',
        timelineText: `用户取消任务${stop.stopped.length > 0 ? `；已停止 ${stop.stopped.length} 个关联会话` : ''}`,
      })
      if (!transition.ok) return { ok: false, conflict: true, message: transition.message }
      // 取消成功：依赖它的仍可派发的后继会收到 [task-dependency-blocked]（Host 不改后继状态）。
      await deps.dependencyNotifier?.afterDependencyInvalidated(taskId)
      return { ok: true, task: transition.task, duplicate: !transition.changed }
    },

    async archiveTask(taskId) {
      const task = deps.stores.tasks.get(taskId)
      if (task === undefined) return { ok: false, conflict: true, message: `task '${taskId}' not found` }
      if (task.status === 'archived') return { ok: true, task, duplicate: true }
      if (!ARCHIVE_SOURCES.includes(task.status)) return { ok: false, conflict: true, message: `只能从 review|done|cancelled 归档，当前 ${task.status}` }
      const source = task.status
      const transition = await transitionTask({ stores: deps.stores, now, ...(deps.notifyChanged !== undefined ? { onTaskChanged: (row) => deps.notifyChanged?.(row.id, row.status) } : {}) }, {
        taskId,
        to: 'archived',
        actor: 'user_archive',
        timelineText: `已归档（原状态 ${source}）`,
        mutate: (current, at) => {
          const kept = current.timeline.filter((item) => item.type === 'created').slice(0, 1)
          const last = current.timeline.length > 0 ? current.timeline[current.timeline.length - 1] : undefined
          return {
            archivedAt: at,
            timeline: [...kept, ...(last !== undefined && last.type !== 'created' ? [last] : []), { at, type: 'status' as const, text: `已归档（原状态 ${source}）` }].slice(-100),
          }
        },
      })
      if (!transition.ok) return { ok: false, conflict: true, message: transition.message }
      if (!transition.changed) return { ok: true, task: transition.task, duplicate: true }
      // review 来源归档 = 依赖不会自动满足；cancelled 来源在取消时已通知，不重复。
      if (source === 'review') await deps.dependencyNotifier?.afterDependencyInvalidated(taskId)
      return { ok: true, task: transition.task, duplicate: false }
    },

    async restoreTask(taskId) {
      const task = deps.stores.tasks.get(taskId)
      if (task === undefined) return { ok: false, conflict: true, message: `task '${taskId}' not found` }
      if (task.status !== 'archived') return { ok: false, conflict: true, message: `只有 archived 可恢复，当前 ${task.status}` }
      const target = restoreTargetOf(task)
      const transition = await transitionTask({ stores: deps.stores, now, ...(deps.notifyChanged !== undefined ? { onTaskChanged: (row) => deps.notifyChanged?.(row.id, row.status) } : {}) }, {
        taskId,
        to: target,
        actor: 'user_restore',
        timelineText: `从回收站恢复为 ${target}`,
      })
      if (!transition.ok) return { ok: false, conflict: true, message: transition.message }
      // 恢复为 draft 可能让任务重新 ready（依赖已满足）。
      await deps.dependencyNotifier?.afterTasksChanged(taskId)
      return { ok: true, task: transition.task, duplicate: !transition.changed }
    },

    listArchive(options) {
      const limit = Math.min(Math.max(Number.isInteger(options.limit) ? (options.limit as number) : 50, 1), ARCHIVE_LIST_MAX)
      const cursor = typeof options.cursor === 'number' && Number.isFinite(options.cursor) ? options.cursor : undefined
      const rows = deps.stores.tasks
        .list()
        .filter((task) => task.status === 'archived' || task.status === 'cancelled')
        .filter((task) => (cursor === undefined ? true : task.updatedAt < cursor))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? (page[page.length - 1]?.updatedAt ?? null) : null
      return { tasks: page, nextCursor }
    },

    detailBoardEdits(taskId) {
      return deps.stores.boardEdits
        .list()
        .filter((edit) => edit.taskId === taskId)
        .sort((a, b) => b.at - a.at)
        .slice(0, BOARD_EDITS_DETAIL_MAX)
        .map((edit) => ({ editId: edit.id, field: edit.field, before: edit.before, after: edit.after, at: edit.at, injectedAt: edit.injectedAt ?? null }))
    },

    staleOf(task) {
      return taskIsStale(task, now())
    },

    async backfill() {
      if (disposed) return
      const stale = deps.stores.boardEdits
        .list()
        .filter((edit) => edit.injectedAt === undefined && edit.at < now())
        .sort((a, b) => a.at - b.at)
      const byTask = new Map<string, BoardEditRecord[]>()
      for (const edit of stale) {
        const list = byTask.get(edit.taskId) ?? []
        list.push(edit)
        byTask.set(edit.taskId, list)
      }
      for (const [taskId, edits] of byTask) {
        const task = deps.stores.tasks.get(taskId)
        if (task === undefined) continue
        const record: MergeRecord = {
          taskId,
          editIds: edits.map((edit) => edit.id),
          before: {},
          after: {},
          timer: undefined,
        }
        for (const edit of edits) {
          record.before[edit.field as BoardField] = record.before[edit.field as BoardField] ?? edit.before
          record.after[edit.field as BoardField] = edit.after
        }
        try {
          await deps.deliverer.deliverContextMessage(buildBoardEditText(task, record), `board-edit-backfill-${boardEditInjectionKey(taskId, record.editIds).slice(0, 16)}`, {
            kind: 'commander-board-edit',
            summary: '看板人工改动',
          })
          await markInjected(record, now())
        } catch (error) {
          deps.logger?.warn?.(`[commander] board-edit backfill failed: ${String((error as Error)?.message ?? error)}`)
        }
      }
    },

    dispose() {
      disposed = true
      for (const record of merges.values()) clearMergeTimer(record)
      merges.clear()
      for (const timer of disposers) clearTimeout(timer)
      disposers.clear()
    },

    pendingMerges() {
      return merges.size
    },
  }
  return service
}

export type { DeliverError }
