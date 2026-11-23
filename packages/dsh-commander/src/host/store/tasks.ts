// tasks 表仓储（key=taskId；权威任务记录 + 有界 timeline；应用层 version 重试）。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import { appendTimeline, updateWithVersion } from './base.ts'
import type { TaskRecord, TaskTimelineItem } from '../schema.ts'

export interface TaskStore {
  get(taskId: string): TaskRecord | undefined
  list(): TaskRecord[]
  put(record: TaskRecord): Promise<void>
  appendTimeline(taskId: string, item: TaskTimelineItem, expectedVersion?: number | null): Promise<TaskRecord>
  update(taskId: string, mutate: (current: TaskRecord) => TaskRecord, expectedVersion?: number | null): Promise<TaskRecord>
}

export function createTaskStore(domain: DomainHandle): TaskStore {
  const table = domain.table<TaskRecord>('tasks') as DomainTable<TaskRecord>
  return {
    get(taskId) {
      return table.get(taskId)
    },
    list() {
      return [...table.entries()].map(([, value]) => value)
    },
    async put(record) {
      await table.put(record.id, record)
    },
    async appendTimeline(taskId, item, expectedVersion = null) {
      return updateWithVersion(table, taskId, expectedVersion, (current) => ({
        ...current,
        timeline: appendTimeline(current.timeline, item),
        version: current.version + 1,
        updatedAt: item.at,
        lastActivityAt: item.at,
      }))
    },
    async update(taskId, mutate, expectedVersion = null) {
      return updateWithVersion(table, taskId, expectedVersion, (current) => ({ ...mutate(current), version: current.version + 1 }))
    },
  }
}
