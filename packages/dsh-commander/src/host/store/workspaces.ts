// workspaces 表仓储（key=workspaceId 归一化；数组整体替换语义见 m0-contract-patch §2.3）。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import { MissingKeyError, sanitizeKey } from './base.ts'
import type { WorkspaceRecord } from '../schema.ts'

export interface WorkspaceStore {
  get(workspaceId: string): WorkspaceRecord | undefined
  list(): WorkspaceRecord[]
  put(record: WorkspaceRecord): Promise<void>
  /** 原子读改写（domain 写链串行）：只用于局部字段更新，避免覆盖并发写入的其它字段。 */
  patch(workspaceId: string, mutate: (current: WorkspaceRecord) => WorkspaceRecord): Promise<WorkspaceRecord | undefined>
  replaceAll(records: WorkspaceRecord[]): Promise<WorkspaceRecord[]>
}

export function createWorkspaceStore(domain: DomainHandle): WorkspaceStore {
  const table = domain.table<WorkspaceRecord>('workspaces') as DomainTable<WorkspaceRecord>
  return {
    get(workspaceId) {
      return table.get(sanitizeKey(workspaceId))
    },
    list() {
      return [...table.entries()].map(([, value]) => value)
    },
    async put(record) {
      await table.put(sanitizeKey(record.id), record)
    },
    async patch(workspaceId, mutate) {
      const key = sanitizeKey(workspaceId)
      if (table.get(key) === undefined) return undefined
      try {
        return await table.update(key, mutate)
      } catch (error) {
        // 记录在 update 前被整表替换删掉：调用方按“不存在”处理（fake 与真实域错误形状不完全一致）。
        if (error instanceof MissingKeyError || (error instanceof Error && error.message.includes('missing-key'))) return undefined
        throw error
      }
    },
    async replaceAll(records) {
      const nextKeys = new Set(records.map((record) => sanitizeKey(record.id)))
      const existingKeys = [...table.keys()]
      for (const key of existingKeys) if (!nextKeys.has(key)) await table.delete(key)
      for (const record of records) await table.put(sanitizeKey(record.id), record)
      return records
    },
  }
}
